import type { AppConfig } from "./config";
import { supplierIdentity } from "./account-procurement-advice";
import { scoreRecentDatabaseRow } from "./account-score-database";
import { modelRoutingPatternsSql } from "./scoring-error-policy";
import type { OperationsStore } from "./operations-store";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

type Row = Record<string, unknown>;

const candidateHistorySql = `
WITH low_balance AS (
  SELECT * FROM jsonb_to_recordset(
    CASE WHEN jsonb_typeof($1::jsonb)='array' THEN $1::jsonb
      ELSE (($1::jsonb)#>>'{}')::jsonb END
  )
    AS x(account_id bigint, wallet_key text, balance_cny numeric, anchor_at timestamptz)
), billing_patterns AS (
  SELECT value::text AS pattern FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof($2::jsonb)='array' THEN $2::jsonb
      ELSE (($2::jsonb)#>>'{}')::jsonb END
  )
), current_billing AS (
  SELECT a.id AS account_id, billing_event.anchor_at
  FROM accounts a
  LEFT JOIN LATERAL (
    SELECT MAX(o.created_at) AS anchor_at
    FROM ops_error_logs o
    WHERE o.account_id=a.id
      AND EXISTS (
        SELECT 1 FROM billing_patterns p
        WHERE LOWER(CONCAT_WS(' ', o.error_message, o.error_body,
          o.upstream_error_message, o.upstream_error_detail)) LIKE p.pattern
      )
      AND LOWER(COALESCE(o.error_type, '')) <> 'failover_event'
  ) billing_event ON true
  WHERE a.deleted_at IS NULL
    AND LOWER(TRIM(COALESCE(a.type, '')))='apikey'
    AND EXISTS (
      SELECT 1 FROM billing_patterns p
      WHERE LOWER(COALESCE(a.error_message, '')) LIKE p.pattern
    )
), candidates AS (
  SELECT a.id AS account_id, a.name AS account_name,
    RTRIM(COALESCE(a.credentials->>'base_url', ''), '/') AS base_url, a.platform,
    a.type AS account_type, a.status, a.schedulable, a.error_message,
    a.priority::int AS priority, a.rate_limit_reset_at, a.overload_until,
    a.temp_unschedulable_until, lb.wallet_key, lb.balance_cny,
    CASE
      WHEN cb.account_id IS NOT NULL THEN 'billing-depleted'
      WHEN lb.balance_cny <= 0 THEN 'balance-depleted'
      ELSE 'low-balance'
    END AS primary_reason,
    COALESCE(CASE WHEN cb.account_id IS NOT NULL THEN cb.anchor_at ELSE NULL END, lb.anchor_at, NOW()) AS anchor_at
  FROM accounts a
  LEFT JOIN low_balance lb ON lb.account_id=a.id
  LEFT JOIN current_billing cb ON cb.account_id=a.id
  WHERE a.deleted_at IS NULL
    AND LOWER(TRIM(COALESCE(a.type, ''))) = 'apikey'
    AND (cb.account_id IS NOT NULL OR lb.account_id IS NOT NULL)
), internal_probe_keys AS (
  SELECT k.id FROM api_keys k JOIN users u ON u.id=k.user_id
  WHERE u.email='monitor-user@sub2api.platform-infra.local'
    AND u.deleted_at IS NULL AND k.deleted_at IS NULL
), events AS (
  SELECT 'usage'::text AS kind, u.id, u.request_id, u.created_at,
    u.stream, u.first_token_ms::bigint AS first_token_ms, u.duration_ms::bigint,
    u.actual_cost::numeric, NULL::int AS client_status_code,
    NULL::int AS upstream_status_code, false AS scoreable, u.account_id,
    u.api_key_id, 1::numeric AS score_weight
  FROM usage_logs u JOIN candidates c ON c.account_id=u.account_id
  WHERE u.created_at >= c.anchor_at - ($3::int * INTERVAL '1 hour')
    AND u.created_at < c.anchor_at
    AND LOWER(CONCAT_WS(' ', u.requested_model, u.model, u.upstream_model)) NOT LIKE '%luna%'
    AND NOT EXISTS (SELECT 1 FROM internal_probe_keys p WHERE p.id=u.api_key_id)
  UNION ALL
  SELECT 'error'::text, o.id, o.request_id, o.created_at, o.stream,
    o.time_to_first_token_ms::bigint, o.duration_ms::bigint, 0::numeric,
    o.status_code::int, o.upstream_status_code::int,
    CASE
      WHEN COALESCE(o.status_code, o.upstream_status_code, 0) BETWEEN 200 AND 399 THEN false
      WHEN LOWER(CONCAT_WS(' ', o.error_message, o.error_body,
        o.upstream_error_message, o.upstream_error_detail)) LIKE ANY(ARRAY[
          '%insufficient_balance%', '%insufficient account balance%',
          '%balance is insufficient%', '%余额不足%', '%额度不足%'
        ]) THEN false
      WHEN LOWER(CONCAT_WS(' ', o.error_message, o.error_body,
        o.upstream_error_message, o.upstream_error_detail)) LIKE ANY(${modelRoutingPatternsSql}) THEN false
      WHEN LOWER(COALESCE(o.error_phase, '')) IN ('internal','client','business') THEN false
      WHEN o.error_phase='upstream' OR LOWER(COALESCE(o.error_type,'')) LIKE '%upstream%' THEN true
      WHEN LOWER(COALESCE(o.error_message,'')) LIKE ANY(ARRAY[
        '%upstream service temporarily unavailable%', '%upstream request failed%',
        '%bad gateway%', '%gateway timeout%', '%error code: 502%',
        '%error code: 503%', '%error code: 504%', '%error code: 524%'
      ]) THEN true ELSE false
    END AS scoreable, o.account_id, o.api_key_id, 1::numeric AS score_weight
  FROM ops_error_logs o JOIN candidates c ON c.account_id=o.account_id
  WHERE o.created_at >= c.anchor_at - ($3::int * INTERVAL '1 hour')
    AND o.created_at < c.anchor_at
    AND LOWER(CONCAT_WS(' ', o.requested_model, o.model, o.upstream_model)) NOT LIKE '%luna%'
    AND LOWER(COALESCE(o.inbound_endpoint,'')) IN ('/v1/messages','/v1/responses','/responses/compact','/v1/responses/compact')
    AND (COALESCE(o.status_code,0) >= 400 OR COALESCE(o.upstream_status_code,0) >= 400 OR o.error_type='cyber_policy')
    AND NOT (COALESCE(o.status_code,o.upstream_status_code,0) BETWEEN 200 AND 399)
    AND NOT EXISTS (SELECT 1 FROM internal_probe_keys p WHERE p.id=o.api_key_id)
), deduplicated AS (
  SELECT e.*, ROW_NUMBER() OVER (
    PARTITION BY COALESCE(e.request_id::text, CONCAT('row:', e.id::text))
    ORDER BY (e.kind='usage') DESC, e.created_at DESC, e.id DESC
  ) AS request_rank
  FROM events e
), selected AS (
  SELECT * FROM deduplicated WHERE request_rank=1
), stats AS (
  SELECT c.account_id,
    COALESCE(SUM(s.score_weight) FILTER (WHERE s.kind='usage'),0)::numeric AS success_requests,
    COALESCE(SUM(s.score_weight) FILTER (WHERE s.kind='error' AND s.scoreable),0)::numeric AS failure_requests,
    COALESCE(SUM(s.score_weight) FILTER (WHERE s.kind='usage' OR s.scoreable),0)::numeric AS attributed_requests,
    COALESCE(SUM(s.score_weight) FILTER (WHERE s.kind='error'),0)::numeric AS customer_error_requests,
    COALESCE(SUM(s.score_weight) FILTER (WHERE s.kind='error' AND NOT s.scoreable),0)::numeric AS excluded_error_requests,
    COALESCE(SUM(s.score_weight) FILTER (WHERE s.kind='usage' AND s.stream),0)::numeric AS stream_success_requests,
    COALESCE(SUM(s.score_weight) FILTER (WHERE s.kind='usage' AND s.stream AND s.first_token_ms IS NOT NULL),0)::numeric AS first_token_samples,
    ARRAY_AGG(s.first_token_ms ORDER BY s.first_token_ms) FILTER (WHERE s.kind='usage' AND s.stream AND s.first_token_ms IS NOT NULL) AS ttft_values,
    ARRAY_AGG(s.score_weight ORDER BY s.first_token_ms) FILTER (WHERE s.kind='usage' AND s.stream AND s.first_token_ms IS NOT NULL) AS ttft_weights,
    ARRAY_AGG(s.duration_ms ORDER BY s.duration_ms) FILTER (WHERE s.duration_ms IS NOT NULL) AS duration_values,
    ARRAY_AGG(s.score_weight ORDER BY s.duration_ms) FILTER (WHERE s.duration_ms IS NOT NULL) AS duration_weights,
    COALESCE(SUM(s.actual_cost * s.score_weight) FILTER (WHERE s.kind='usage'),0)::numeric AS api_amount_usd,
    COUNT(s.id)::int AS selected_calls
  FROM candidates c LEFT JOIN selected s ON s.account_id=c.account_id
  GROUP BY c.account_id
)
SELECT c.*, s.* FROM candidates c JOIN stats s USING(account_id) ORDER BY c.account_id
`;

function number(value: unknown): number | null {
  const parsed = Number(value);
  return value === null || value === undefined || !Number.isFinite(parsed) ? null : parsed;
}

function object(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {};
}

function billingPatterns(config: AppConfig): string[] {
  return [...new Set([
    ...config.sub2api.priorityPlan.procurementAdvice.billingErrorPatterns,
    ...config.sub2api.grokPriorityPlan.procurementAdvice.billingErrorPatterns,
  ].map((value) => value.toLowerCase()))];
}

export function lowWalletRows(rows: Row[], threshold: number, lookbackHours: number): Row[] {
  const latest = new Map<string, Row>();
  for (const row of rows) {
    const wallet = String(row.wallet_key ?? "").trim();
    const balance = number(row.remaining_cny);
    if (!wallet || balance === null || balance >= threshold || row.probe_ok !== true) continue;
    const current = latest.get(wallet);
    if (!current || Date.parse(String(row.sampled_at)) > Date.parse(String(current.sampled_at))) latest.set(wallet, row);
  }
  const output: Row[] = [];
  for (const row of latest.values()) {
    const anchor = String(row.sampled_at);
    const ids = [Number(row.account_id), ...((Array.isArray(row.account_cost_inputs) ? row.account_cost_inputs : [])
      .map((item) => Number(object(item).accountId)))];
    for (const accountId of new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))) {
      output.push({ account_id: accountId, wallet_key: row.wallet_key, balance_cny: Number(row.remaining_cny), anchor_at: anchor, lookbackHours });
    }
  }
  return output;
}

function recommendation(row: Row, retiredSuppliers: Set<string>): Row {
  const score = number(row.score);
  const apiUsd = number(object(row.usage).apiAmountUsd) ?? 0;
  const rate = number(row.costRateCnyPerApiUsd);
  const maxCost = Math.max(rate ?? 0, 1);
  const quality = score === null ? 0 : score;
  const production = Math.min(20, apiUsd * 20);
  const cost = rate === null ? 0 : Math.max(0, 10 - Math.min(10, rate / maxCost * 10));
  const balance = number(row.balanceCny);
  const urgency = String(row.reason).includes("depleted")
    ? 20
    : Math.max(0, Math.min(20, (10 - (balance ?? 10)) * 2));
  const observedAttempts = number(row.observedAttempts) ?? 0;
  const supplier = supplierIdentity(row.base_url || row.accountName);
  const retired = supplier !== null && retiredSuppliers.has(supplier);
  const action = retired
    ? "supplier-retired"
    : score === null || observedAttempts < 10
    ? "insufficient-evidence"
    : score >= 80 ? "recharge-priority"
    : score >= 60 ? "recharge-review"
    : "do-not-recharge";
  return {
    ...row,
    recommendationScore: Math.round((quality * 0.5 + production + cost + urgency) * 10) / 10,
    recommendation: action,
    supplier,
    supplierLifecycle: retired ? "retired" : "active",
    recommendationFactors: {
      qualityScore: score,
      apiAmountUsd: apiUsd,
      costRateCnyPerApiUsd: rate,
      balanceCny: balance,
      urgencyScore: urgency,
    },
  };
}

export async function collectRechargeCandidates(
  config: AppConfig,
  store: OperationsStore,
  reads: Sub2ApiReadClient,
): Promise<Row> {
  const policy = config.operations.upstreamManagement.rechargeCandidates;
  const retiredSuppliers = new Set(policy.retiredSuppliers.map((value) => supplierIdentity(value)).filter((value): value is string => value !== null));
  const walletRows = await store.getLatestSuccessfulUpstreamQuotaSamples() as Row[];
  const low = lowWalletRows(walletRows, policy.lowBalanceCny, policy.lookbackHours);
  const startedAt = performance.now();
  const query = await reads.query<Row>({
    key: `upstreams.recharge-candidates:${policy.lowBalanceCny}:${policy.lookbackHours}:${JSON.stringify(low)}`,
    kind: "upstreams.recharge-candidates",
    sql: candidateHistorySql,
    parameters: [JSON.stringify(low), JSON.stringify(billingPatterns(config).map((value) => `%${value}%`)), policy.lookbackHours],
    priority: "manual",
    cacheMode: "bypass-cache",
    setupStatements: ["SET LOCAL random_page_cost = 1"],
  });
  const accounts = query.rows.map((row) => {
    const scorePolicy = String(row.platform).toLowerCase() === "grok" ? config.sub2api.grokScorePolicy : config.sub2api.scorePolicy;
    const scored = scoreRecentDatabaseRow(row, 1000, scorePolicy, Date.now(), billingPatterns(config));
    const anchorAt = new Date(String(row.anchor_at)).toISOString();
    return recommendation({
      ...scored,
      base_url: row.base_url,
      reason: row.primary_reason === "billing-depleted" && low.some((item) => Number(item.account_id) === Number(row.account_id))
        ? "billing-depleted+low-balance" : row.primary_reason,
      balanceCny: number(row.balance_cny), walletKey: row.wallet_key, anchorAt,
      historicalWindow: `${new Date(Date.parse(anchorAt) - policy.lookbackHours * 3_600_000).toISOString()}/${anchorAt}`,
      costRateCnyPerApiUsd: scored.usage && typeof scored.usage === "object" ? number(object(scored.usage).costRateCnyPerApiUsd) : null,
    }, retiredSuppliers);
  }).sort((left, right) => (number(right.recommendationScore) ?? 0) - (number(left.recommendationScore) ?? 0));
  return {
    ok: true, mode: "recharge-candidates-24h-before-anchor", lowBalanceThresholdCny: policy.lowBalanceCny,
    lookbackHours: policy.lookbackHours, candidateCount: accounts.length,
    billingDepletedCount: accounts.filter((row) => String(row.reason).includes("billing-depleted")).length,
    balanceDepletedCount: accounts.filter((row) => String(row.reason).includes("balance-depleted")).length,
    lowBalanceCount: accounts.filter((row) => String(row.reason).includes("low-balance")).length,
    retiredSupplierCount: accounts.filter((row) => row.supplierLifecycle === "retired").length,
    recommendedCount: accounts.filter((row) => String(row.recommendation).startsWith("recharge-")).length,
    databaseQueries: 1, hostQuotaRows: walletRows.length,
    queueDurationMs: query.queueDurationMs, queryDurationMs: query.queryDurationMs,
    totalDurationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    candidates: accounts.slice(0, policy.recommendationLimit), valuesPrinted: false,
  };
}

export const rechargeCandidatesQuery = candidateHistorySql;
