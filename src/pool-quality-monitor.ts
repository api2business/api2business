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

const poolQualityEventsSql = `
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
), usage_events AS (
    SELECT 'usage'::text AS kind, u.id, u.request_id, u.created_at, u.account_id,
      u.user_id, requester.email AS user_email,
      a.name AS account_name, a.base_url, u.stream, u.first_token_ms::bigint AS first_token_ms,
      u.duration_ms::bigint, false AS scoreable, NULL::text AS exclusion_reason,
      COALESCE(u.requested_model, u.model, 'unknown') AS model,
      u.upstream_model, NULL::text AS inbound_endpoint, NULL::text AS upstream_endpoint,
      NULL::text AS error_phase, NULL::text AS error_type,
      NULL::int AS client_status_code, NULL::int AS upstream_status_code,
      NULL::text AS error_message, NULL::text AS upstream_error_message,
      NULL::text AS upstream_error_detail
    FROM usage_logs u JOIN target_accounts a ON a.id = u.account_id
    LEFT JOIN users requester ON requester.id = u.user_id
    WHERE u.request_id IS NOT NULL
      AND u.created_at <= $3::timestamptz
      AND LOWER(CONCAT_WS(' ', u.requested_model, u.model, u.upstream_model)) NOT LIKE '%luna%'
      AND NOT EXISTS (SELECT 1 FROM internal_probe_keys p WHERE p.id = u.api_key_id)
), error_sources AS (
    SELECT 'error'::text AS kind, o.id, o.request_id, o.created_at, o.account_id,
      o.user_id, requester.email AS user_email,
      a.name AS account_name, a.base_url, o.stream,
      o.time_to_first_token_ms::bigint AS first_token_ms,
      o.duration_ms::bigint, COALESCE(o.requested_model, o.model, 'unknown') AS model,
      o.upstream_model, o.inbound_endpoint, o.upstream_endpoint, o.error_phase, o.error_type,
      o.status_code::int AS client_status_code, o.upstream_status_code::int AS upstream_status_code,
      o.error_message, o.upstream_error_message, o.upstream_error_detail,
      LOWER(CONCAT_WS(' ', o.error_message, o.error_body,
        o.upstream_error_message, o.upstream_error_detail)) AS message_text
    FROM ops_error_logs o JOIN target_accounts a ON a.id = o.account_id
    LEFT JOIN users requester ON requester.id = o.user_id
    WHERE (
      COALESCE(o.status_code, 0) >= 400
      OR COALESCE(o.upstream_status_code, 0) >= 400
      OR o.error_type = 'cyber_policy'
    )
      AND o.request_id IS NOT NULL
      AND o.created_at <= $3::timestamptz
      AND LOWER(CONCAT_WS(' ', o.requested_model, o.model, o.upstream_model)) NOT LIKE '%luna%'
      -- 上游失败但入站已成功的 failover 中间事件不是用户错误。
      AND NOT (COALESCE(o.status_code, o.upstream_status_code, 0) BETWEEN 200 AND 399)
      AND LOWER(COALESCE(o.error_type, '')) <> 'failover_event'
      AND LOWER(COALESCE(o.inbound_endpoint, '')) IN (
        '/v1/messages', '/v1/responses', '/responses/compact', '/v1/responses/compact'
      )
      AND NOT EXISTS (SELECT 1 FROM internal_probe_keys p WHERE p.id = o.api_key_id)
), error_events AS (
    SELECT source.*,
      CASE
        WHEN LOWER(COALESCE(source.error_message, '')) LIKE '%context window%'
          OR LOWER(COALESCE(source.error_message, '')) LIKE '%context_length_exceeded%'
          OR LOWER(COALESCE(source.error_message, '')) LIKE '%input must be a list%'
          OR source.message_text LIKE ANY (ARRAY[
            '%insufficient_balance%',
            '%insufficient account balance%',
            '%balance is insufficient%',
            '%余额不足%',
            '%额度不足%',
            '%model_not_found%',
            '%model not found%'
          ])
          OR LOWER(COALESCE(source.error_message, '')) LIKE '%not supported by any configured account%'
          OR LOWER(COALESCE(source.error_message, '')) LIKE '%no available channel for model%'
          OR LOWER(COALESCE(source.error_phase, '')) IN ('internal', 'client', 'business') THEN false
        WHEN source.error_phase = 'upstream' OR LOWER(COALESCE(source.error_type, '')) LIKE '%upstream%' THEN true
        WHEN LOWER(COALESCE(source.error_message, '')) LIKE ANY (ARRAY[
          '%upstream service temporarily unavailable%', '%upstream request failed%',
          '%bad gateway%', '%gateway timeout%', '%error code: 502%', '%error code: 503%',
          '%error code: 504%', '%error code: 524%'
        ]) THEN true
        ELSE false
      END AS scoreable,
      CASE
        WHEN LOWER(COALESCE(source.error_message, '')) LIKE '%context window%'
          OR LOWER(COALESCE(source.error_message, '')) LIKE '%context_length_exceeded%'
          OR LOWER(COALESCE(source.error_message, '')) LIKE '%input must be a list%'
          THEN 'client_request'
        WHEN source.message_text LIKE ANY (ARRAY[
          '%insufficient_balance%', '%insufficient account balance%',
          '%balance is insufficient%', '%余额不足%', '%额度不足%'
        ]) THEN 'insufficient_balance'
        WHEN source.message_text LIKE ANY (ARRAY[
          '%model_not_found%', '%model not found%',
          '%not supported by any configured account%', '%no available channel for model%'
        ]) THEN 'model_routing'
        WHEN LOWER(COALESCE(source.error_phase, '')) IN ('internal', 'client', 'business')
          THEN 'non_upstream'
        ELSE 'unscored_error'
      END AS exclusion_reason
    FROM error_sources source
), raw_events AS (
    SELECT * FROM usage_events
    UNION ALL
    SELECT kind, id, request_id, created_at, account_id, user_id, user_email, account_name, base_url,
      stream, first_token_ms, duration_ms, scoreable, exclusion_reason, model,
      upstream_model, inbound_endpoint, upstream_endpoint, error_phase, error_type,
      client_status_code, upstream_status_code, error_message,
      upstream_error_message, upstream_error_detail
    FROM error_events
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
`;

export const poolQualitySql = `${poolQualityEventsSql}
SELECT e.*,
  EXISTS (
    SELECT 1 FROM ops_system_logs s
    WHERE s.account_id=e.account_id AND s.request_id=e.request_id
      AND s.message LIKE '%upstream_failover_switching'
  ) AS failover_triggered
FROM recent_events e ORDER BY e.created_at DESC, e.id DESC
`;

export type PoolQualityErrorFilter = "scoreable" | "excluded" | "all";

export const poolQualityErrorsSql = `${poolQualityEventsSql}, filtered_errors AS (
  SELECT e.*,
    EXISTS (
      SELECT 1 FROM ops_system_logs s
      WHERE s.account_id=e.account_id AND s.request_id=e.request_id
        AND s.message LIKE '%upstream_failover_switching'
    ) AS failover_triggered
  FROM recent_events e
  WHERE e.kind = 'error'
    AND NOT (COALESCE(e.client_status_code, e.upstream_status_code, 0) BETWEEN 200 AND 399)
    AND ($4::text = 'all'
      OR ($4::text = 'scoreable' AND e.scoreable = true)
      OR ($4::text = 'excluded' AND e.scoreable = false))
), numbered_errors AS (
  SELECT e.*, ROW_NUMBER() OVER (ORDER BY e.created_at DESC, e.id DESC) AS row_number
  FROM filtered_errors e
)
SELECT
  COUNT(*)::int AS total_count,
  COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT(
    'requestId', request_id,
    'createdAt', created_at,
    'model', model,
    'upstreamModel', upstream_model,
    'userId', user_id,
    'userEmail', user_email,
    'accountId', account_id,
    'accountName', account_name,
    'clientStatusCode', client_status_code,
    'upstreamStatusCode', upstream_status_code,
    'inboundEndpoint', inbound_endpoint,
    'upstreamEndpoint', upstream_endpoint,
    'stream', stream,
    'errorPhase', error_phase,
    'errorType', error_type,
    'errorMessage', error_message,
    'upstreamErrorMessage', upstream_error_message,
    'upstreamErrorDetail', upstream_error_detail,
    'failoverTriggered', failover_triggered,
    'scoreable', scoreable,
    'exclusionReason', exclusion_reason
  ) ORDER BY created_at DESC, id DESC) FILTER (
    WHERE row_number > $6::int AND row_number <= ($6::int + $5::int)
  ), '[]'::jsonb) AS rows,
  COALESCE((
    SELECT JSONB_AGG(JSONB_BUILD_OBJECT('model', model, 'count', requests)
      ORDER BY requests DESC, model)
    FROM (
      SELECT model, COUNT(*)::int AS requests
      FROM filtered_errors
      GROUP BY model
    ) distribution
  ), '[]'::jsonb) AS model_distribution
FROM numbered_errors
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
    key: `pool-quality:${recentCallLimit}:${groupIds.join(",")}:${sampledAt}`,
    kind: "pool-quality-sample",
    priority: "automatic",
    cacheMode: "bypass-cache",
    sql: poolQualitySql,
    parameters: [recentCallLimit, groupIds.join(","), sampledAt],
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

export async function collectPoolQualityErrors(
  config: AppConfig,
  reads: Sub2ApiReadClient,
  input: {
    sampledAt: string;
    page: number;
    pageSize: number;
    filter: PoolQualityErrorFilter;
  },
) {
  const recentCallLimit = 1000;
  if (!Number.isInteger(input.page) || input.page < 1) throw new Error("pool quality error page must be a positive integer");
  if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) {
    throw new Error("pool quality error page size must be from 1 to 100");
  }
  if (!(["scoreable", "excluded", "all"] as string[]).includes(input.filter)) {
    throw new Error("pool quality error filter is invalid");
  }
  const sampledAtMs = Date.parse(input.sampledAt);
  if (!Number.isFinite(sampledAtMs)) throw new Error("pool quality sampledAt is invalid");
  const sampledAt = new Date(sampledAtMs).toISOString();
  const groupIds = [...new Set(config.sub2api.priorityPlan.eligibleGroupIds)].sort((a, b) => a - b);
  const offset = (input.page - 1) * input.pageSize;
  const query = await reads.query<Row>({
    key: JSON.stringify(["pool-quality-errors", recentCallLimit, groupIds, sampledAt, input.filter, input.page, input.pageSize]),
    kind: "pool-quality-errors",
    priority: "manual",
    cacheMode: "prefer-cache",
    sql: poolQualityErrorsSql,
    parameters: [recentCallLimit, groupIds.join(","), sampledAt, input.filter, input.pageSize, offset],
  });
  const result = query.rows[0] ?? {};
  const total = Number(result.total_count ?? 0);
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const modelDistribution = Array.isArray(result.model_distribution) ? result.model_distribution : [];
  return {
    ok: true,
    sampledAt,
    recentCallLimit,
    groupIds,
    filter: input.filter,
    rows,
    modelDistribution,
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / input.pageSize)),
    },
    databaseQueries: query.cached ? 0 : 1,
    queueDurationMs: query.queueDurationMs,
    queryDurationMs: query.queryDurationMs,
    valuesPrinted: false,
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
