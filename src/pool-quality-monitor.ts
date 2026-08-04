import type { AppConfig } from "./config";
import { scoreRecentDatabaseRow } from "./account-score-database";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
type Row = Record<string, unknown>;

export interface PoolParticipation {
  accountId: number;
  accountName: string;
  baseUrl: string;
  attempts: number;
  ratio: number;
  costRateCnyPerApiUsd: number | null;
  costSource: "detected" | "manual" | null;
}

export const poolQualitySql = `
WITH internal_probe_keys AS (
  SELECT k.id
  FROM api_keys k
  JOIN users owner ON owner.id = k.user_id
  WHERE owner.email = 'monitor-user@sub2api.platform-infra.local'
    AND owner.deleted_at IS NULL
    AND k.deleted_at IS NULL
), target_accounts AS (
  SELECT a.id, a.name, RTRIM(COALESCE(a.credentials->>'base_url', ''), '/') AS base_url
  FROM accounts a
  WHERE a.deleted_at IS NULL
    AND LOWER(TRIM(COALESCE(a.type, ''))) = 'apikey'
    AND NULLIF(a.credentials->>'base_url', '') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM account_groups ag
      WHERE ag.account_id = a.id AND ag.group_id = ANY(string_to_array($2, ',')::bigint[])
    )
), raw_events AS (
    SELECT 'usage'::text AS kind, u.id, u.request_id, u.created_at, u.account_id,
      a.name AS account_name, a.base_url, u.stream, u.first_token_ms::bigint,
      u.duration_ms::bigint, false AS scoreable, NULL::int AS client_status_code
    FROM usage_logs u JOIN target_accounts a ON a.id = u.account_id
    WHERE u.request_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM internal_probe_keys p WHERE p.id = u.api_key_id)
    UNION ALL
    SELECT 'error'::text AS kind, o.id, o.request_id, o.created_at, o.account_id,
      a.name AS account_name, a.base_url, o.stream, o.time_to_first_token_ms::bigint,
      o.duration_ms::bigint,
      CASE
        WHEN LOWER(COALESCE(o.error_message, '')) LIKE '%context window%'
          OR LOWER(COALESCE(o.error_message, '')) LIKE '%context_length_exceeded%'
          OR LOWER(COALESCE(o.error_message, '')) LIKE '%input must be a list%'
          OR LOWER(COALESCE(o.error_message, '')) LIKE '%not supported by any configured account%'
          OR LOWER(COALESCE(o.error_message, '')) LIKE '%no available channel for model%'
          OR LOWER(COALESCE(o.error_phase, '')) IN ('internal', 'client', 'business') THEN false
        WHEN o.error_phase = 'upstream' OR LOWER(COALESCE(o.error_type, '')) LIKE '%upstream%' THEN true
        WHEN LOWER(COALESCE(o.error_message, '')) LIKE ANY (ARRAY[
          '%upstream service temporarily unavailable%', '%upstream request failed%',
          '%bad gateway%', '%gateway timeout%', '%error code: 502%', '%error code: 503%',
          '%error code: 504%', '%error code: 524%'
        ]) THEN true
        ELSE false
      END AS scoreable,
      o.status_code::int AS client_status_code
    FROM ops_error_logs o JOIN target_accounts a ON a.id = o.account_id
    WHERE (
      COALESCE(o.status_code, 0) >= 400
      OR COALESCE(o.upstream_status_code, 0) >= 400
      OR o.error_type = 'cyber_policy'
    )
      AND o.request_id IS NOT NULL
      AND LOWER(COALESCE(o.error_type, '')) <> 'failover_event'
      AND LOWER(COALESCE(o.inbound_endpoint, '')) IN (
        '/v1/messages', '/v1/responses', '/responses/compact', '/v1/responses/compact'
      )
      AND NOT EXISTS (SELECT 1 FROM internal_probe_keys p WHERE p.id = o.api_key_id)
), final_events AS (
  SELECT event.*,
    ROW_NUMBER() OVER (
      PARTITION BY event.request_id
      ORDER BY (event.kind = 'usage') DESC, event.created_at DESC, event.id DESC
    ) AS request_rank
  FROM raw_events event
), recent_events AS (
  SELECT * FROM final_events
  WHERE request_rank = 1
  ORDER BY created_at DESC, id DESC
  LIMIT $1
)
SELECT e.*,
  EXISTS (
    SELECT 1 FROM ops_system_logs s
    WHERE s.account_id=e.account_id AND s.request_id=e.request_id
      AND s.message LIKE '%upstream_failover_switching'
  ) AS failover_triggered
FROM recent_events e ORDER BY e.created_at DESC, e.id DESC
`;

function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return Math.round(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower));
}

export interface PoolQualitySample {
  sampledAt: string;
  score: number | null;
  grade: string;
  observedAttempts: number;
  successRequests: number;
  failureRequests: number;
  failureRate: number | null;
  failoverRequests: number;
  failoverRecovered: number;
  ttftP95Ms: number | null;
  firstTokenSamples: number;
  participation: PoolParticipation[];
}

export async function collectPoolQualitySample(
  config: AppConfig,
  reads: Sub2ApiReadClient,
  sampledAt = new Date().toISOString(),
): Promise<PoolQualitySample> {
  const recentCallLimit = 1000;
  const groupIds = [...new Set(config.sub2api.priorityPlan.eligibleGroupIds)].sort((a, b) => a - b);
  const query = await reads.query<Row>({
    key: `pool-quality:${recentCallLimit}:${groupIds.join(",")}`,
    kind: "pool-quality-sample",
    priority: "automatic",
    cacheMode: "bypass-cache",
    sql: poolQualitySql,
    parameters: [recentCallLimit, groupIds.join(",")],
  });
  const rows = query.rows;
  const successes = rows.filter((row) => row.kind === "usage");
  const failures = rows.filter((row) => row.kind === "error" && row.scoreable === true);
  const failovers = rows.filter((row) => row.failover_triggered === true);
  const recovered = failovers.filter((row) => row.kind === "usage");
  const ttft = successes.map((row) => Number(row.first_token_ms)).filter((value) => Number.isFinite(value) && value >= 0);
  const accounts = new Map<number, { accountName: string; baseUrl: string; attempts: number }>();
  for (const row of rows) {
    const accountId = Number(row.account_id);
    if (!Number.isInteger(accountId) || accountId < 1) continue;
    const current = accounts.get(accountId);
    accounts.set(accountId, {
      accountName: String(row.account_name ?? `#${accountId}`),
      baseUrl: String(row.base_url ?? ""),
      attempts: (current?.attempts ?? 0) + 1,
    });
  }
  const scored = scoreRecentDatabaseRow({
    account_id: 0, account_name: "混池 + 自用池", platform: "openai", account_type: "apikey",
    status: "active", schedulable: true, priority: 0, group_ids: groupIds, group_names: ["混池", "自用"],
    success_requests: successes.length, failure_requests: failures.length,
    attributed_requests: new Set(rows.map((row) => row.request_id).filter(Boolean)).size,
    failover_requests: new Set(failovers.map((row) => row.request_id).filter(Boolean)).size,
    failover_recovered: new Set(recovered.map((row) => row.request_id).filter(Boolean)).size,
    failover_failed: 0, failover_aborted: 0, burst_attempts: rows.length,
    burst_failure_requests: failures.length, stream_success_requests: successes.filter((row) => row.stream === true).length,
    first_token_samples: ttft.length, ttft_p50_ms: percentile(ttft, 0.5), ttft_p95_ms: percentile(ttft, 0.95),
    ttft_p99_ms: percentile(ttft, 0.99), ttft_max_ms: ttft.length ? Math.max(...ttft) : null,
    duration_p95_ms: percentile(successes.map((row) => Number(row.duration_ms)).filter(Number.isFinite), 0.95),
    customer_error_requests: failures.length, excluded_error_requests: rows.filter((row) => row.kind === "error" && row.scoreable !== true).length,
    token_count: 0, api_amount_usd: 0,
  }, recentCallLimit, config.sub2api.poolScorePolicy);
  const total = rows.length;
  return {
    sampledAt,
    score: scored.score == null ? null : Number(scored.score),
    grade: String(scored.grade ?? "insufficient"),
    observedAttempts: Number(scored.observedAttempts ?? total),
    successRequests: successes.length,
    failureRequests: failures.length,
    failureRate: scored.failureRate == null ? null : Number(scored.failureRate),
    failoverRequests: Number(scored.failoverRequests ?? 0),
    failoverRecovered: Number(scored.failoverRecovered ?? 0),
    ttftP95Ms: scored.ttftP95Ms == null ? null : Number(scored.ttftP95Ms),
    firstTokenSamples: ttft.length,
    participation: [...accounts.entries()].map(([accountId, account]) => {
      const manualMatch = account.accountName.match(/(\d+(?:\.\d+)?)$/u);
      return {
        accountId,
        accountName: account.accountName,
        baseUrl: account.baseUrl,
        attempts: account.attempts,
        ratio: total > 0 ? Math.round(account.attempts / total * 1_000_000) / 1_000_000 : 0,
        costRateCnyPerApiUsd: manualMatch ? Number(manualMatch[1]) : null,
        costSource: manualMatch ? "manual" : null,
      } satisfies PoolParticipation;
    }).sort((a, b) => b.attempts - a.attempts || a.accountId - b.accountId),
  };
}

export function poolQualityHistory(rows: Row[]) {
  const points = rows.map((row) => ({
    sampledAt: new Date(String(row.sampled_at)).toISOString(),
    score: row.score == null ? null : Number(row.score),
    failureRate: row.failure_rate == null ? null : Number(row.failure_rate),
    ttftP95Ms: row.ttft_p95_ms == null ? null : Number(row.ttft_p95_ms),
  }));
  return points.map((point, index) => {
    const cutoff = Date.parse(point.sampledAt) - 60 * 60 * 1000;
    const window = points.slice(0, index + 1).filter((candidate) => Date.parse(candidate.sampledAt) >= cutoff && candidate.score != null && Number.isFinite(candidate.score));
    const rollingScore = window.length ? window.reduce((total, candidate) => total + Number(candidate.score), 0) / window.length : null;
    return { ...point, rollingScore: rollingScore == null ? null : Math.round(rollingScore * 10) / 10 };
  });
}
