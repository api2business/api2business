import { SQL } from "bun";
import type { AppConfig } from "./config";
import { readSecret } from "./secrets";

type Row = Record<string, unknown>;

const recentAccountAggregateSql = `
WITH target_accounts AS (
  SELECT
    a.id AS account_id,
    a.name AS account_name,
    a.platform,
    a.status,
    a.schedulable,
    a.error_message,
    a.rate_limit_reset_at,
    a.overload_until,
    a.temp_unschedulable_until,
    a.priority::int AS priority,
    ARRAY_AGG(g.id ORDER BY g.id) AS group_ids,
    ARRAY_AGG(g.name ORDER BY g.id) AS group_names
  FROM accounts a
  JOIN account_groups ag ON ag.account_id = a.id
  JOIN groups g ON g.id = ag.group_id AND g.deleted_at IS NULL
  WHERE a.deleted_at IS NULL
    AND ($2::text IS NULL OR a.id::text = $2::text OR a.name = $2::text)
  GROUP BY a.id
),
account_stats AS (
  SELECT
    a.account_id,
    COUNT(*) FILTER (WHERE e.kind = 'usage')::int AS success_requests,
    COUNT(DISTINCT e.request_id) FILTER (
      WHERE e.kind = 'error' AND e.scoreable AND e.request_id IS NOT NULL
    )::int AS failure_requests,
    COUNT(DISTINCT e.request_id) FILTER (
      WHERE e.kind = 'error' AND e.request_id IS NOT NULL
    )::int AS customer_error_requests,
    COUNT(*) FILTER (WHERE e.kind = 'error' AND NOT e.scoreable)::int AS excluded_error_requests,
    COUNT(*) FILTER (WHERE e.kind = 'usage' AND e.stream)::int AS stream_success_requests,
    COUNT(e.first_token_ms) FILTER (WHERE e.kind = 'usage' AND e.stream)::int AS first_token_samples,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY e.first_token_ms)
      FILTER (WHERE e.kind = 'usage' AND e.stream AND e.first_token_ms IS NOT NULL) AS ttft_p50_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.first_token_ms)
      FILTER (WHERE e.kind = 'usage' AND e.stream AND e.first_token_ms IS NOT NULL) AS ttft_p95_ms,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY e.first_token_ms)
      FILTER (WHERE e.kind = 'usage' AND e.stream AND e.first_token_ms IS NOT NULL) AS ttft_p99_ms,
    MAX(e.first_token_ms) FILTER (WHERE e.kind = 'usage' AND e.stream) AS ttft_max_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.duration_ms)
      FILTER (WHERE e.kind = 'usage' AND e.duration_ms IS NOT NULL) AS duration_p95_ms,
    COALESCE(SUM(e.input_tokens + e.output_tokens) FILTER (WHERE e.kind = 'usage'), 0)::bigint AS token_count,
    COALESCE(SUM(e.actual_cost) FILTER (WHERE e.kind = 'usage'), 0)::numeric AS api_amount_usd,
    COUNT(*)::int AS selected_calls
  FROM target_accounts a
  LEFT JOIN LATERAL (
    SELECT candidate.*
    FROM (
      (
        SELECT
          'usage'::text AS kind,
          u.id,
          u.request_id,
          u.created_at,
          u.stream,
          u.first_token_ms::bigint,
          u.duration_ms::bigint,
          u.input_tokens::bigint,
          u.output_tokens::bigint,
          u.actual_cost::numeric,
          false AS scoreable
        FROM usage_logs u
        WHERE u.account_id = a.account_id
        ORDER BY u.created_at DESC
        LIMIT $1
      )
      UNION ALL
      (
        SELECT
          'error'::text AS kind,
          o.id,
          o.request_id,
          o.created_at,
          o.stream,
          o.time_to_first_token_ms,
          o.duration_ms::bigint,
          0::bigint,
          0::bigint,
          0::numeric,
          CASE
            WHEN LOWER(COALESCE(o.error_message, '')) LIKE '%context window%'
              OR LOWER(COALESCE(o.error_message, '')) LIKE '%context_length_exceeded%' THEN false
            WHEN LOWER(COALESCE(o.error_message, '')) LIKE '%input must be a list%' THEN false
            WHEN LOWER(COALESCE(o.error_message, '')) LIKE '%not supported by any configured account%'
              OR LOWER(COALESCE(o.error_message, '')) LIKE '%no available channel for model%' THEN false
            WHEN LOWER(COALESCE(o.error_phase, '')) IN ('internal', 'client', 'business') THEN false
            WHEN o.error_phase = 'upstream' OR LOWER(COALESCE(o.error_type, '')) LIKE '%upstream%' THEN true
            WHEN LOWER(COALESCE(o.error_message, '')) LIKE ANY (ARRAY[
              '%upstream service temporarily unavailable%',
              '%upstream request failed%',
              '%bad gateway%',
              '%gateway timeout%',
              '%error code: 502%',
              '%error code: 503%',
              '%error code: 504%',
              '%error code: 524%'
            ]) THEN true
            ELSE false
          END AS scoreable
        FROM ops_error_logs o
        WHERE o.account_id = a.account_id
          AND (COALESCE(o.status_code, 0) >= 400 OR o.error_type = 'cyber_policy')
        ORDER BY o.created_at DESC
        LIMIT $1
      )
    ) candidate
    ORDER BY candidate.created_at DESC
    LIMIT $1
  ) e ON true
  GROUP BY a.account_id
)
SELECT a.*, s.*
FROM target_accounts a
JOIN account_stats s USING (account_id)
ORDER BY a.account_id
`;

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isFinite(parsed) ? parsed : null;
}

function percentile(value: unknown): number | null {
  const parsed = numeric(value);
  return parsed === null ? null : Math.round(parsed);
}

function costRate(name: string): number | null {
  const match = name.match(/(\d+(?:\.\d+)?)$/u);
  return match ? Number(match[1]) : null;
}

function grade(score: number | null, comparable: boolean, attempts: number): string {
  if (score === null || (!comparable && !(score < 60 && attempts >= 10))) return "insufficient";
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "E";
}

export function scoreRecentDatabaseRow(row: Row, recentCallLimit: number, now = Date.now()): Row {
  const successRequests = numeric(row.success_requests) ?? 0;
  const failureRequests = numeric(row.failure_requests) ?? 0;
  const observedAttempts = successRequests + failureRequests;
  const failureRate = observedAttempts > 0 ? Math.round(failureRequests / observedAttempts * 1_000_000) / 1_000_000 : null;
  const firstTokenSamples = numeric(row.first_token_samples) ?? 0;
  const streamSuccessRequests = numeric(row.stream_success_requests) ?? 0;
  const ttftP95Ms = percentile(row.ttft_p95_ms);
  const reliability = failureRate === null ? null : Math.round(60 * (1 - Math.min(Math.max(failureRate, 0), 0.2) / 0.2) * 100) / 100;
  const latency = firstTokenSamples < 5 || ttftP95Ms === null
    ? null
    : Math.round(25 * (1 - Math.min(Math.max(ttftP95Ms - 10_000, 0), 170_000) / 170_000) * 100) / 100;
  // 当前状态只展示，不参与最近调用质量分。
  const availableWeight = (reliability === null ? 0 : 60) + (latency === null ? 0 : 25) + 15;
  const score = observedAttempts > 0
    ? Math.round(((reliability ?? 0) + (latency ?? 0) + 15) / availableWeight * 1_000) / 10
    : null;
  const comparable = observedAttempts >= 10 && firstTokenSamples >= 5;
  const accountGrade = grade(score, comparable, observedAttempts);
  const untilActive = (value: unknown): boolean => {
    const parsed = Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) && parsed > now;
  };
  const currentAvailable = row.status === "active"
    && row.schedulable === true
    && !untilActive(row.rate_limit_reset_at)
    && !untilActive(row.overload_until)
    && !untilActive(row.temp_unschedulable_until);
  const accountName = String(row.account_name ?? "");
  const apiAmountUsd = numeric(row.api_amount_usd) ?? 0;
  const rate = costRate(accountName);
  return {
    accountId: numeric(row.account_id),
    accountName,
    status: row.status,
    schedulable: row.schedulable,
    priority: numeric(row.priority),
    priorityOrder: "lower-is-higher",
    groupIds: Array.isArray(row.group_ids) ? row.group_ids.map(Number) : [],
    groupNames: Array.isArray(row.group_names) ? row.group_names.map(String) : [],
    currentAvailable,
    currentStatus: row.status,
    currentError: row.error_message ?? null,
    currentStateScoreImpact: "none",
    score,
    grade: accountGrade,
    assessment: ({ A: "preferred", B: "healthy", C: "watch", D: "degraded", E: "poor" } as Row)[accountGrade] ?? "insufficient-evidence",
    confidence: observedAttempts >= 50 && firstTokenSamples >= 20 ? "high" : observedAttempts >= 10 && firstTokenSamples >= 5 ? "medium" : "low",
    scoreComparable: comparable,
    observedAttempts,
    successRequests,
    failureRequests,
    failureRate,
    streamSuccessRequests,
    firstTokenSamples,
    firstTokenCoverage: streamSuccessRequests > 0 ? Math.round(firstTokenSamples / streamSuccessRequests * 1_000_000) / 1_000_000 : null,
    ttftP50Ms: percentile(row.ttft_p50_ms),
    ttftP95Ms,
    ttftP99Ms: percentile(row.ttft_p99_ms),
    ttftMaxMs: percentile(row.ttft_max_ms),
    durationP95Ms: percentile(row.duration_p95_ms),
    customerErrorRequests: numeric(row.customer_error_requests) ?? 0,
    scoreableUpstreamErrorRequests: failureRequests,
    excludedNonUpstreamErrorRequests: numeric(row.excluded_error_requests) ?? 0,
    usage: {
      requestCount: successRequests,
      tokenCount: numeric(row.token_count) ?? 0,
      apiAmountUsd,
      costRateCnyPerApiUsd: rate,
      upstreamCostCny: rate === null ? null : Math.round(apiAmountUsd * rate * 100_000_000) / 100_000_000,
    },
    scoreComponents: { reliability, latency, availability: 15, availableWeight },
    recentCallLimit,
    selectedCalls: numeric(row.selected_calls) ?? 0,
    evidenceMode: "recent-account-calls-postgresql",
  };
}

function sortScores(rows: Row[]): Row[] {
  const order = { A: 0, B: 1, C: 2, D: 3, E: 4, insufficient: 5 } as Record<string, number>;
  return rows.sort((left, right) => {
    const gradeDelta = (order[String(left.grade)] ?? 6) - (order[String(right.grade)] ?? 6);
    return gradeDelta || Number(right.score ?? -1) - Number(left.score ?? -1);
  });
}

export async function collectRecentCallScoresFromDatabase(
  config: AppConfig,
  recentCallLimit: number,
  accountSelector: string | null = null,
): Promise<{ ok: true; mode: string; recentCallLimit: number; accountCount: number; databaseQueries: number; queryDurationMs: number; totalDurationMs: number; accounts: Row[] }> {
  if (!Number.isInteger(recentCallLimit) || recentCallLimit < 1 || recentCallLimit > 10000) {
    throw new Error("recent call limit must be an integer from 1 to 10000");
  }
  const databaseUrl = readSecret(config, config.sub2api.scoreDatabase);
  const database = new SQL(databaseUrl, { max: 1 });
  const startedAt = performance.now();
  let queryDurationMs = 0;
  try {
    const rows = await database.begin(async (transaction) => {
      await transaction.unsafe("SET TRANSACTION READ ONLY");
      await transaction.unsafe(`SET LOCAL statement_timeout = '${config.sub2api.scoreDatabase.statementTimeoutMs}ms'`);
      // PK01 的评分热数据常驻缓存；降低本事务随机页成本，避免规划器为每个
      // 账号反复扫描全局 created_at 索引，优先使用 account_id 复合索引。
      await transaction.unsafe("SET LOCAL random_page_cost = 1");
      const queryStartedAt = performance.now();
      const result = await transaction.unsafe(recentAccountAggregateSql, [recentCallLimit, accountSelector]);
      queryDurationMs = Math.round((performance.now() - queryStartedAt) * 10) / 10;
      return result;
    }) as unknown as Row[];
    const selected = rows.filter((row) => accountSelector === null
      || String(row.account_id) === accountSelector
      || String(row.account_name) === accountSelector);
    if (accountSelector !== null && selected.length !== 1) throw new Error(`account selector did not resolve exactly once: ${accountSelector}`);
    const accounts = sortScores(selected.map((row) => scoreRecentDatabaseRow(row, recentCallLimit)));
    return {
      ok: true,
      mode: "recent-account-calls-postgresql-local-score",
      recentCallLimit,
      accountCount: accounts.length,
      databaseQueries: 1,
      queryDurationMs,
      totalDurationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      accounts,
    };
  } finally {
    await database.close();
  }
}

export const recentAccountAggregateQuery = recentAccountAggregateSql;
