import type { AppConfig } from "./config";
import type {
  Sub2ApiReadClient,
  Sub2ApiReadPriority,
} from "./sub2api-read-executor";
import { isOAuthAccount } from "./account-score-eligibility";

type Row = Record<string, unknown>;

const recentAccountAggregateSql = `
WITH target_accounts AS (
  SELECT
    a.id AS account_id,
    a.name AS account_name,
    a.platform,
    a.type AS account_type,
    a.status,
    a.schedulable,
    a.error_message,
    a.rate_limit_reset_at,
    a.overload_until,
    a.temp_unschedulable_until,
    CASE
      WHEN COALESCE(a.extra->>'codex_7d_used_percent', '') ~ '^[0-9]+(?:\\.[0-9]+)?$'
      THEN LEAST(100, GREATEST(0, 100 - (a.extra->>'codex_7d_used_percent')::numeric))
      ELSE NULL
    END AS weekly_remaining_percent,
    a.priority::int AS priority,
    ARRAY_AGG(g.id ORDER BY g.id) AS group_ids,
    ARRAY_AGG(g.name ORDER BY g.id) AS group_names
  FROM accounts a
  JOIN account_groups ag ON ag.account_id = a.id
  JOIN groups g ON g.id = ag.group_id AND g.deleted_at IS NULL
  WHERE a.deleted_at IS NULL
    AND LOWER(TRIM(COALESCE(a.type, ''))) <> 'oauth'
    AND ($2::text IS NULL OR a.id::text = $2::text OR a.name = $2::text)
    AND (
      $3::text IS NULL
      OR EXISTS (
        SELECT 1
        FROM account_groups selected_ag
        JOIN groups selected_g
          ON selected_g.id = selected_ag.group_id
          AND selected_g.deleted_at IS NULL
        WHERE selected_ag.account_id = a.id
          AND (
            selected_g.id::text = $3::text
            OR selected_g.name = $3::text
          )
      )
    )
  GROUP BY a.id
),
account_stats AS (
  SELECT
    a.account_id,
    COUNT(*) FILTER (WHERE e.kind = 'usage')::int AS success_requests,
    COUNT(DISTINCT e.request_id) FILTER (WHERE e.request_id IS NOT NULL)::int AS attributed_requests,
    COUNT(DISTINCT e.request_id) FILTER (
      WHERE e.request_id IS NOT NULL AND f.triggered
    )::int AS failover_requests,
    COUNT(DISTINCT e.request_id) FILTER (
      WHERE e.request_id IS NOT NULL
        AND f.triggered
        AND e.kind = 'error'
        AND e.client_status_code BETWEEN 200 AND 399
    )::int AS failover_recovered,
    COUNT(DISTINCT e.request_id) FILTER (
      WHERE e.request_id IS NOT NULL
        AND f.triggered
        AND e.kind = 'error'
        AND e.client_status_code >= 400
    )::int AS failover_failed,
    COUNT(DISTINCT e.request_id) FILTER (
      WHERE e.kind = 'error' AND e.scoreable AND e.request_id IS NOT NULL
    )::int AS failure_requests,
    COUNT(*) FILTER (
      WHERE e.recent_rank <= $4
    )::int AS burst_attempts,
    COUNT(DISTINCT e.request_id) FILTER (
      WHERE e.recent_rank <= $4
        AND e.kind = 'error'
        AND e.scoreable
        AND e.request_id IS NOT NULL
    )::int AS burst_failure_requests,
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
    SELECT
      candidate.*,
      ROW_NUMBER() OVER (ORDER BY candidate.created_at DESC, candidate.id DESC) AS recent_rank
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
          NULL::int AS client_status_code,
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
          o.status_code::int AS client_status_code,
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
          AND (
            COALESCE(o.status_code, 0) >= 400
            OR COALESCE(o.upstream_status_code, 0) >= 400
            OR o.error_type = 'cyber_policy'
          )
        ORDER BY o.created_at DESC
        LIMIT $1
      )
    ) candidate
    ORDER BY candidate.created_at DESC
    LIMIT $1
  ) e ON true
  LEFT JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1
      FROM ops_system_logs system_log
      WHERE system_log.account_id = a.account_id
        AND system_log.request_id = e.request_id
        AND system_log.message = 'openai.upstream_failover_switching'
    ) AS triggered
  ) f ON true
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

function availabilityReason(row: Row, currentAvailable: boolean, billingErrorPatterns: string[], now: number): Row | null {
  if (currentAvailable) return null;
  const error = String(row.error_message ?? "").trim();
  const normalizedError = error.toLowerCase();
  const weeklyRemainingPercent = numeric(row.weekly_remaining_percent);
  const activeUntil = (value: unknown): string | null => {
    const parsed = Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) && parsed > now ? new Date(parsed).toISOString() : null;
  };
  const timedStates = [
    { value: row.rate_limit_reset_at, code: "rate-limited", label: "限流冷却" },
    { value: row.overload_until, code: "upstream-overloaded", label: "上游过载" },
    { value: row.temp_unschedulable_until, code: "temporarily-unschedulable", label: "临时不可调度" },
  ];

  if (weeklyRemainingPercent !== null && weeklyRemainingPercent <= 0) {
    return { code: "weekly-quota", label: "周限额已用尽", detail: "7 天剩余 0%", resetAt: null };
  }
  if (normalizedError && billingErrorPatterns.some((pattern) => normalizedError.includes(pattern.toLowerCase()))) {
    return { code: "billing-depleted", label: "费用不足", detail: "上游余额或预扣额度不足", resetAt: null };
  }
  if (/token (?:revoked|invalid|expired)|authentication token|invalid api key|unauthorized|鉴权|令牌.*(?:失效|过期)/iu.test(error)) {
    return { code: "authentication", label: "鉴权失效", detail: "上游凭据已失效", resetAt: null };
  }
  if (/api key.*(?:分组|权限)|专属分组|所属分组|forbidden.*(?:group|permission)/iu.test(error)) {
    return { code: "account-permission", label: "账号权限异常", detail: "上游 API Key 或分组权限不可用", resetAt: null };
  }
  for (const state of timedStates) {
    const resetAt = activeUntil(state.value);
    if (resetAt !== null) return { code: state.code, label: state.label, detail: "等待自动恢复", resetAt };
  }
  if (row.status !== "active") {
    return { code: "account-error", label: "账号错误", detail: error ? "上游已返回错误" : "未记录上游错误原因", resetAt: null };
  }
  if (row.schedulable !== true) {
    return { code: "unschedulable", label: "已停止调度", detail: "未记录停止调度原因", resetAt: null };
  }
  return { code: "unknown", label: "原因未记录", detail: "当前状态不可用，但没有可判定的原因证据", resetAt: null };
}

function grade(score: number | null, comparable: boolean, attempts: number): string {
  if (score === null || (!comparable && !(score < 60 && attempts >= 10))) return "insufficient";
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "E";
}

export function scoreRecentDatabaseRow(
  row: Row,
  recentCallLimit: number,
  policy: AppConfig["sub2api"]["scorePolicy"],
  now = Date.now(),
  billingErrorPatterns: string[] = [],
): Row {
  if (policy.ttftZeroScoreMs <= policy.ttftFullScoreMs) throw new Error("TTFT zero-score boundary must exceed full-score boundary");
  const totalWeight = policy.reliabilityWeight + policy.failoverWeight + policy.latencyWeight + policy.baselineWeight;
  if (totalWeight !== 100) throw new Error("account score policy weights must total 100");
  const successRequests = numeric(row.success_requests) ?? 0;
  const failureRequests = numeric(row.failure_requests) ?? 0;
  const observedAttempts = successRequests + failureRequests;
  const failureRate = observedAttempts > 0 ? Math.round(failureRequests / observedAttempts * 1_000_000) / 1_000_000 : null;
  const burstAttempts = numeric(row.burst_attempts) ?? 0;
  const burstFailureRequests = numeric(row.burst_failure_requests) ?? 0;
  const burstFailureRate = burstAttempts > 0
    ? Math.round(burstFailureRequests / burstAttempts * 1_000_000) / 1_000_000
    : null;
  const effectiveFailureRate = failureRate === null
    ? burstFailureRate
    : burstFailureRate === null ? failureRate : Math.max(failureRate, burstFailureRate);
  const attributedRequests = numeric(row.attributed_requests) ?? 0;
  const failoverRequests = numeric(row.failover_requests) ?? 0;
  const failoverRecovered = Math.min(failoverRequests, numeric(row.failover_recovered) ?? 0);
  const failoverFailed = Math.min(
    Math.max(0, failoverRequests - failoverRecovered),
    numeric(row.failover_failed) ?? 0,
  );
  const failoverRate = attributedRequests > 0 ? Math.round(failoverRequests / attributedRequests * 1_000_000) / 1_000_000 : null;
  const firstTokenSamples = numeric(row.first_token_samples) ?? 0;
  const streamSuccessRequests = numeric(row.stream_success_requests) ?? 0;
  const ttftP95Ms = percentile(row.ttft_p95_ms);
  const reliability = effectiveFailureRate === null ? null : Math.round(policy.reliabilityWeight * (1 - Math.min(Math.max(effectiveFailureRate, 0), policy.failureZeroScoreRate) / policy.failureZeroScoreRate) * 100) / 100;
  const failover = failoverRate === null ? null : Math.round(policy.failoverWeight * (1 - Math.min(Math.max(failoverRate, 0), policy.failoverZeroScoreRate) / policy.failoverZeroScoreRate) * 100) / 100;
  const latency = firstTokenSamples < 5 || ttftP95Ms === null
    ? null
    : Math.round(policy.latencyWeight * (1 - Math.min(
      Math.max(ttftP95Ms - policy.ttftFullScoreMs, 0),
      policy.ttftZeroScoreMs - policy.ttftFullScoreMs,
    ) / (policy.ttftZeroScoreMs - policy.ttftFullScoreMs)) * 100) / 100;
  // 当前状态只展示，不参与最近调用质量分。
  const availableWeight = (reliability === null ? 0 : policy.reliabilityWeight)
    + (failover === null ? 0 : policy.failoverWeight)
    + (latency === null ? 0 : policy.latencyWeight)
    + policy.baselineWeight;
  const score = observedAttempts > 0
    ? Math.round(((reliability ?? 0) + (failover ?? 0) + (latency ?? 0) + policy.baselineWeight) / availableWeight * 1_000) / 10
    : null;
  const comparable = observedAttempts >= 10 && firstTokenSamples >= 5;
  const accountGrade = grade(score, comparable, observedAttempts);
  const untilActive = (value: unknown): boolean => {
    const parsed = Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) && parsed > now;
  };
  const weeklyRemainingPercent = numeric(row.weekly_remaining_percent);
  const currentAvailable = row.status === "active"
    && row.schedulable === true
    && (weeklyRemainingPercent === null || weeklyRemainingPercent > 0)
    && !untilActive(row.rate_limit_reset_at)
    && !untilActive(row.overload_until)
    && !untilActive(row.temp_unschedulable_until);
  const accountName = String(row.account_name ?? "");
  const apiAmountUsd = numeric(row.api_amount_usd) ?? 0;
  const rate = costRate(accountName);
  return {
    accountId: numeric(row.account_id),
    accountName,
    platform: row.platform,
    accountType: row.account_type ?? row.type ?? null,
    status: row.status,
    schedulable: row.schedulable,
    priority: numeric(row.priority),
    priorityOrder: "lower-is-higher",
    groupIds: Array.isArray(row.group_ids) ? row.group_ids.map(Number) : [],
    groupNames: Array.isArray(row.group_names) ? row.group_names.map(String) : [],
    currentAvailable,
    availabilityReason: availabilityReason(row, currentAvailable, billingErrorPatterns, now),
    currentStatus: row.status,
    currentError: row.error_message ?? null,
    rateLimitResetAt: row.rate_limit_reset_at ?? null,
    overloadUntil: row.overload_until ?? null,
    tempUnschedulableUntil: row.temp_unschedulable_until ?? null,
    currentStateScoreImpact: "none",
    weeklyRemainingPercent,
    score,
    grade: accountGrade,
    assessment: ({ A: "preferred", B: "healthy", C: "watch", D: "degraded", E: "poor" } as Row)[accountGrade] ?? "insufficient-evidence",
    confidence: observedAttempts >= 50 && firstTokenSamples >= 20 ? "high" : observedAttempts >= 10 && firstTokenSamples >= 5 ? "medium" : "low",
    scoreComparable: comparable,
    observedAttempts,
    successRequests,
    failureRequests,
    failureRate,
    burstCallLimit: policy.failureBurstCallLimit,
    burstAttempts,
    burstFailureRequests,
    burstFailureRate,
    effectiveFailureRate,
    attributedRequests,
    failoverRequests,
    failoverRecovered,
    failoverFailed,
    failoverOutcomeMissing: Math.max(0, failoverRequests - failoverRecovered - failoverFailed),
    failoverRate,
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
    scoreComponents: { reliability, failover, latency, baseline: policy.baselineWeight, availableWeight },
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
  reads: Sub2ApiReadClient,
  accountSelector: string | null = null,
  groupSelector: string | null = null,
  priority: Sub2ApiReadPriority = "manual",
): Promise<{
  ok: true;
  mode: string;
  recentCallLimit: number;
  accountSelector: string | null;
  groupSelector: string | null;
  accountCount: number;
  databaseQueries: number;
  queueDurationMs: number;
  queryDurationMs: number;
  totalDurationMs: number;
  collectionStartedAt: string;
  queryStartedAt: string;
  queryCompletedAt: string;
  collectedAt: string;
  deduplicated: boolean;
  cached: boolean;
  accounts: Row[];
}> {
  if (!Number.isInteger(recentCallLimit) || recentCallLimit < 1 || recentCallLimit > 10000) {
    throw new Error("recent call limit must be an integer from 1 to 10000");
  }
  const startedAt = performance.now();
  const collectionStartedAt = new Date().toISOString();
  const query = await reads.query<Row>({
    key: JSON.stringify([
      "scores.rank",
      recentCallLimit,
      accountSelector,
      groupSelector,
      Math.min(recentCallLimit, config.sub2api.scorePolicy.failureBurstCallLimit),
    ]),
    kind: "scores.rank",
    sql: recentAccountAggregateSql,
    parameters: [
      recentCallLimit,
      accountSelector,
      groupSelector,
      Math.min(recentCallLimit, config.sub2api.scorePolicy.failureBurstCallLimit),
    ],
    priority,
    cacheMode: priority === "automatic" ? "prefer-cache" : "bypass-cache",
    // PK01 的评分热数据常驻缓存；降低本事务随机页成本，避免规划器为每个
    // 账号反复扫描全局 created_at 索引，优先使用 account_id 复合索引。
    setupStatements: ["SET LOCAL random_page_cost = 1"],
  });
  const rows = query.rows;
    const selected = rows.filter((row) => accountSelector === null
      || String(row.account_id) === accountSelector
      || String(row.account_name) === accountSelector);
    if (accountSelector !== null && selected.length !== 1) throw new Error(`account selector did not resolve exactly once: ${accountSelector}`);
    if (groupSelector !== null && selected.length === 0) throw new Error(`group selector resolved no scoreable accounts: ${groupSelector}`);
    const accounts = sortScores(selected
      .filter((row) => !isOAuthAccount(row))
      .map((row) => scoreRecentDatabaseRow(
        row,
        recentCallLimit,
        String(row.platform) === "grok" ? config.sub2api.grokScorePolicy : config.sub2api.scorePolicy,
        Date.now(),
        (String(row.platform) === "grok" ? config.sub2api.grokPriorityPlan : config.sub2api.priorityPlan).procurementAdvice.billingErrorPatterns,
      )));
  return {
      ok: true,
      mode: "recent-account-calls-postgresql-local-score",
      recentCallLimit,
      accountSelector,
      groupSelector,
      accountCount: accounts.length,
    databaseQueries: query.cached ? 0 : 1,
    queueDurationMs: query.queueDurationMs,
    queryDurationMs: query.queryDurationMs,
    totalDurationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    collectionStartedAt,
    queryStartedAt: query.queryStartedAt,
    queryCompletedAt: query.queryCompletedAt,
    collectedAt: new Date().toISOString(),
    deduplicated: query.deduplicated,
    cached: query.cached,
    accounts,
  };
}

export const recentAccountAggregateQuery = recentAccountAggregateSql;
