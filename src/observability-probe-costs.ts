import type { AppConfig } from "./config";
import { observedRateEventsSql } from "./observability-sql";
import { configuredWalletKey } from "./upstream-wallet";

type Row = Record<string, any>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const finite = (value: unknown): number | null => value === null || value === undefined || value === ""
  || !Number.isFinite(Number(value)) ? null : Number(value);
const iso = (value: unknown): string | null => value instanceof Date ? value.toISOString()
  : Number.isFinite(Date.parse(String(value))) ? new Date(String(value)).toISOString() : null;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const percent = (part: number, total: number) => total > 0 ? part / total * 100 : null;
const round = (value: number, digits = 6) => Number(value.toFixed(digits));

export const PROBE_COST_TOP_N = 10;
export const PROBE_COST_DAY_TOP_N = 3;

// Probe costs intentionally use the inverse predicate of dailyCostSql. Both keep the
// same probe identity: monitor user, api2business-probe-* key, or probe group.
export const probeCostSql = `WITH ${observedRateEventsSql}, probe_keys AS (
  SELECT k.id FROM api_keys k LEFT JOIN users u ON u.id=k.user_id
  WHERE u.email='monitor-user@sub2api.platform-infra.local'
    OR LOWER(COALESCE(k.name,'')) LIKE 'api2business-probe-%'
), usage AS (
  SELECT u.account_id,u.group_id,u.created_at,u.actual_cost,u.rate_multiplier,
    COALESCE(u.input_tokens,0)::bigint AS input_tokens,
    COALESCE(u.output_tokens,0)::bigint AS output_tokens,
    to_char((u.created_at AT TIME ZONE $4)::date,'YYYY-MM-DD') AS day,
    COALESCE(NULLIF(TRIM(u.requested_model),''),NULLIF(TRIM(u.model),''),'unknown') AS model
  FROM usage_logs u LEFT JOIN probe_keys p ON p.id=u.api_key_id
  LEFT JOIN groups g ON g.id=u.group_id
  WHERE u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz
    AND (p.id IS NOT NULL OR LOWER(COALESCE(g.name,'')) LIKE 'api2business-probe-%')
), rate_intervals AS MATERIALIZED (
  SELECT account_id,at,rate_cny,wallet_rate_cny,
    LEAD(at) OVER (PARTITION BY account_id ORDER BY at,rate_cny) AS next_at
  FROM rate_events
), cost_usage AS (
  SELECT u.*,rate.rate_cny AS provider_rate_cny,
    COALESCE(rate.rate_cny,u.rate_multiplier*rate.wallet_rate_cny) AS rate_cny,rate.at AS rate_at FROM usage u
  LEFT JOIN rate_intervals rate ON rate.account_id=u.account_id
    AND rate.at<=u.created_at
    AND (rate.next_at IS NULL OR u.created_at<rate.next_at)
), probe_costs AS (
  SELECT day,account_id,group_id,model,COUNT(*)::int AS records,
    SUM(input_tokens)::bigint AS input_tokens,SUM(output_tokens)::bigint AS output_tokens,
    COUNT(*) FILTER (WHERE actual_cost IS NOT NULL AND actual_cost>=0
      AND rate_multiplier IS NOT NULL AND rate_multiplier>0)::int AS rate_eligible_records,
    COUNT(*) FILTER (WHERE actual_cost IS NOT NULL AND actual_cost>=0
      AND rate_multiplier IS NOT NULL AND rate_multiplier>0 AND rate_cny IS NULL)::int AS rate_fallback_records,
    COUNT(*) FILTER (WHERE actual_cost IS NOT NULL AND actual_cost>=0
      AND rate_multiplier IS NOT NULL AND rate_multiplier>0 AND rate_cny>0)::int AS historical_records,
    COUNT(*) FILTER (WHERE actual_cost IS NOT NULL AND actual_cost>=0
      AND rate_multiplier IS NOT NULL AND rate_multiplier>0 AND rate_cny>0
      AND provider_rate_cny IS NULL)::int AS wallet_rate_records,
    SUM(actual_cost / NULLIF(rate_multiplier,0) * rate_cny)
      FILTER (WHERE actual_cost IS NOT NULL AND actual_cost>=0
        AND rate_multiplier IS NOT NULL AND rate_multiplier>0 AND rate_cny>0)::float8 AS historical_cost_cny,
    SUM(actual_cost / NULLIF(rate_multiplier,0))
      FILTER (WHERE actual_cost IS NOT NULL AND actual_cost>=0
        AND rate_multiplier IS NOT NULL AND rate_multiplier>0 AND rate_cny IS NULL)::float8 AS fallback_cost_usd,
    COUNT(*) FILTER (WHERE actual_cost IS NULL OR actual_cost<0
      OR rate_multiplier IS NULL OR rate_multiplier<=0)::int AS billing_fields_missing_records,
    MIN(created_at) AS first_at,MIN(rate_at) AS first_rate_at,MAX(rate_at) AS last_rate_at
  FROM cost_usage GROUP BY day,account_id,group_id,model
), days AS (
  SELECT to_char(day,'YYYY-MM-DD') AS day,
    (day::timestamp AT TIME ZONE $4) AS start_at,
    ((day + INTERVAL '1 day')::timestamp AT TIME ZONE $4) AS end_at
  FROM generate_series(
    (($1::timestamptz AT TIME ZONE $4)::date)::timestamp,
    ((($2::timestamptz - INTERVAL '1 microsecond') AT TIME ZONE $4)::date)::timestamp,
    INTERVAL '1 day'
  ) day
), account_rows AS (
  SELECT id,name,platform,type,RTRIM(COALESCE(credentials->>'base_url',''),'/') AS base_url,
    deleted_at IS NULL AS active
  FROM accounts WHERE (deleted_at IS NULL AND type='apikey') OR id IN (SELECT account_id FROM probe_costs)
), group_rows AS (
  SELECT id,name FROM groups WHERE id IN (SELECT group_id FROM probe_costs WHERE group_id IS NOT NULL)
)
SELECT jsonb_build_object(
  'probeCosts',COALESCE((SELECT jsonb_agg(t) FROM probe_costs t),'[]'::jsonb),
  'days',COALESCE((SELECT jsonb_agg(t ORDER BY t.day) FROM days t),'[]'::jsonb),
  'accounts',COALESCE((SELECT jsonb_agg(t) FROM account_rows t),'[]'::jsonb),
  'groups',COALESCE((SELECT jsonb_agg(t) FROM group_rows t),'[]'::jsonb)
) AS facts`;

interface CostResolution {
  knownRecords: number;
  missingRecords: number;
  knownCostCny: number;
  fallbackRecords: number;
  walletRateRecords: number;
  missingReasons: Record<string, number>;
}

interface DayBucket { day: string; startAt: string; endAt: string }

function emptyMetrics() {
  return { requests:0,inputTokens:0,outputTokens:0,knownRecords:0,missingRecords:0,knownCostCny:0,
    walletRateRecords:0,activeAccountIds:new Set<number>(),missingReasons:{} as Record<string,number> };
}

type Metrics = ReturnType<typeof emptyMetrics>;

function addReasons(target: Record<string, number>, source: Record<string, number>) {
  for (const [reason, count] of Object.entries(source)) target[reason] = (target[reason] ?? 0) + count;
}

function metricsRow(metrics: Metrics) {
  const records = metrics.knownRecords + metrics.missingRecords;
  return {
    requests: metrics.requests,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    knownRecords: metrics.knownRecords,
    missingRecords: metrics.missingRecords,
    walletRateRecords: metrics.walletRateRecords,
    knownCostCny: round(metrics.knownCostCny),
    costCny: records > 0 && metrics.missingRecords === 0 ? round(metrics.knownCostCny) : null,
    coveragePercent: percent(metrics.knownRecords, records),
    complete: records > 0 && metrics.missingRecords === 0,
    activeAccountCount: metrics.activeAccountIds.size,
    missingReasons: { ...metrics.missingReasons },
  };
}

function resolveCost(cost: Row, cacheRate: { value: number | null; observedAt: string | null }): CostResolution {
  const records = Number(cost.records ?? 0);
  const historical = Math.min(records, Math.max(0, Number(cost.historical_records ?? 0)));
  const fallbackCandidates = Math.min(records - historical, Math.max(0, Number(cost.rate_fallback_records ?? 0)));
  const billingMissing = Math.min(records - historical - fallbackCandidates,
    Math.max(0, Number(cost.billing_fields_missing_records ?? 0)));
  const firstAt = iso(cost.first_at);
  const cacheUsable = cacheRate.value !== null && cacheRate.value > 0 && cacheRate.observedAt !== null
    && firstAt !== null && cacheRate.observedAt <= firstAt;
  const fallbackRecords = cacheUsable ? fallbackCandidates : 0;
  const fallbackCost = cacheUsable ? Number(cost.fallback_cost_usd ?? 0) * cacheRate.value! : 0;
  const knownRecords = historical + fallbackRecords;
  const missingRecords = Math.max(0, records - knownRecords);
  const missingReasons: Record<string, number> = {};
  if (billingMissing > 0) missingReasons.billing_fields_missing = billingMissing;
  const rateMissing = Math.max(0, fallbackCandidates - fallbackRecords);
  if (rateMissing > 0) {
    missingReasons[!cacheRate.value || cacheRate.value <= 0 ? "provider_rate_missing" : "historical_provider_rate_missing"] = rateMissing;
  }
  const unexplained = Math.max(0, missingRecords - sum(Object.values(missingReasons)));
  if (unexplained > 0) missingReasons.unknown_missing_cost_evidence = unexplained;
  return {
    knownRecords,
    missingRecords,
    knownCostCny: Number(cost.historical_cost_cny ?? 0) + fallbackCost,
    fallbackRecords,
    walletRateRecords: Math.min(historical, Math.max(0, Number(cost.wallet_rate_records ?? 0))),
    missingReasons,
  };
}

function addCost(target: Metrics, base: Row, resolution: CostResolution) {
  target.requests += Number(base.records ?? 0);
  target.inputTokens += Number(base.input_tokens ?? 0);
  target.outputTokens += Number(base.output_tokens ?? 0);
  target.knownRecords += resolution.knownRecords;
  target.missingRecords += resolution.missingRecords;
  target.knownCostCny += resolution.knownCostCny;
  target.walletRateRecords += resolution.walletRateRecords;
  target.activeAccountIds.add(Number(base.accountId));
  addReasons(target.missingReasons, resolution.missingReasons);
}

function ranked(entries: Array<[string, Metrics]>, totalKnownCostCny: number, limit: number) {
  return entries.map(([key, metrics]) => ({
    key,
    ...metricsRow(metrics),
    costSharePercent: metrics.knownCostCny > 0 && totalKnownCostCny > 0
      ? metrics.knownCostCny / totalKnownCostCny * 100 : null,
  })).sort((left, right) => (right.knownCostCny - left.knownCostCny)
    || (right.requests - left.requests) || left.key.localeCompare(right.key)).slice(0, limit);
}

function dimension(rows: Row[], keyOf: (base: Row) => string, labelOf: (base: Row) => string,
  limit: number, totalKnownCostCny: number) {
  const entries = new Map<string, { label: string; metrics: Metrics }>();
  for (const base of rows) {
    const key = keyOf(base);
    const entry = entries.get(key) ?? { label: labelOf(base), metrics: emptyMetrics() };
    addCost(entry.metrics, base, base.cost as CostResolution);
    entries.set(key, entry);
  }
  return ranked([...entries.entries()].map(([key, entry]) => [key, entry.metrics]), totalKnownCostCny, limit)
    .map(item => ({ ...item, label: entries.get(item.key)!.label }));
}

export function probeCostReport(facts: Row, cache: Row[], config: AppConfig, options: {
  days: number; asOf: string; timezone: string;
}) {
  const accounts = new Map<number, Row>((facts.accounts ?? []).map((account: Row) => [Number(account.id), account]));
  const groups = new Map<number, Row>((facts.groups ?? []).map((group: Row) => [Number(group.id), group]));
  const cacheByAccount = new Map(cache.map(item => [Number(item.account_id), item]));
  const allDays: DayBucket[] = (facts.days ?? []).map((day: Row) => ({
    day: String(day.day), startAt: iso(day.start_at), endAt: iso(day.end_at),
  })).filter((day: DayBucket): day is DayBucket => Boolean(day.startAt && day.endAt
    && day.startAt < day.endAt && day.startAt < options.asOf));
  const selectedDays = allDays.slice(-options.days);
  const selectedNames = new Set(selectedDays.map((day: Row) => day.day));
  const baselineDays = allDays.slice(Math.max(0, allDays.length - options.days - 7), Math.max(0, allDays.length - options.days));
  const baselineNames = new Set(baselineDays.map((day: Row) => day.day));

  const baseRows = (facts.probeCosts ?? []).map((cost: Row): Row => {
    const account = accounts.get(Number(cost.account_id)) ?? {};
    const group = groups.get(Number(cost.group_id)) ?? {};
    const cacheRow = cacheByAccount.get(Number(cost.account_id));
    const evidence = row(cacheRow?.last_success_result ?? cacheRow?.result);
    const multiplier = row(evidence.billingMultiplier);
    const resolution = resolveCost(cost, { value: finite(multiplier.value), observedAt: iso(multiplier.observedAt) });
    const upstreamKey = configuredWalletKey(account.base_url, config.sub2api.newApiCredentials)
      ?? `unmapped-account-${String(cost.account_id)}`;
    return {
      day: String(cost.day),
      accountId: Number(cost.account_id),
      accountKey: `account:${String(cost.account_id)}`,
      accountLabel: String(account.name ?? `账号 ${String(cost.account_id)}`),
      groupKey: cost.group_id == null ? "group:unassigned" : `group:${String(cost.group_id)}`,
      groupLabel: cost.group_id == null ? "未分组" : String(group.name ?? `分组 ${String(cost.group_id)}`),
      platformKey: `platform:${String(account.platform ?? "unknown")}`,
      platformLabel: String(account.platform ?? "unknown"),
      modelKey: `model:${String(cost.model ?? "unknown")}`,
      modelLabel: String(cost.model ?? "unknown"),
      upstreamKey: `upstream:${upstreamKey}`,
      upstreamLabel: upstreamKey.startsWith("unmapped-account-") ? "未映射上游" : upstreamKey,
      records: Number(cost.records ?? 0),
      input_tokens: Number(cost.input_tokens ?? 0),
      output_tokens: Number(cost.output_tokens ?? 0),
      cost: resolution,
    };
  }).filter((base: Row) => selectedNames.has(base.day) || baselineNames.has(base.day));

  const selectedRows = baseRows.filter((base: Row) => selectedNames.has(base.day));
  const dayReports = selectedDays.map(day => {
    const rows = selectedRows.filter((base: Row) => base.day === day.day);
    const metrics = emptyMetrics();
    for (const base of rows) addCost(metrics, base, base.cost as CostResolution);
    return {
      day: day.day,
      dayStartAt: day.startAt,
      dayEndAt: day.endAt,
      dayComplete: day.endAt <= options.asOf,
      asOf: options.asOf,
      ...metricsRow(metrics),
      distribution: {
        byAccount: dimension(rows, base => String(base.accountKey), base => String(base.accountLabel), PROBE_COST_DAY_TOP_N, metrics.knownCostCny),
        byGroup: dimension(rows, base => String(base.groupKey), base => String(base.groupLabel), PROBE_COST_DAY_TOP_N, metrics.knownCostCny),
        byPlatform: dimension(rows, base => String(base.platformKey), base => String(base.platformLabel), PROBE_COST_DAY_TOP_N, metrics.knownCostCny),
        byModel: dimension(rows, base => String(base.modelKey), base => String(base.modelLabel), PROBE_COST_DAY_TOP_N, metrics.knownCostCny),
        byUpstream: dimension(rows, base => String(base.upstreamKey), base => String(base.upstreamLabel), PROBE_COST_DAY_TOP_N, metrics.knownCostCny),
      },
    };
  });

  const summaryMetrics = emptyMetrics();
  for (const base of selectedRows) addCost(summaryMetrics, base, base.cost as CostResolution);
  const summary = {
    ...metricsRow(summaryMetrics),
    days: dayReports.length,
    completeDays: dayReports.filter(day => day.dayComplete).length,
    partialDays: dayReports.filter(day => !day.dayComplete).length,
    baseline7dMedianCny: null as number | null,
    baseline7dDays: 0,
  };

  const baselineCosts = baselineDays.map(day => {
    const rows = baseRows.filter((base: Row) => base.day === day.day);
    const metrics = emptyMetrics();
    for (const base of rows) addCost(metrics, base, base.cost as CostResolution);
    return { complete: metrics.missingRecords === 0 && metrics.requests > 0, cost: metrics.knownCostCny };
  }).filter(item => item.complete).map(item => item.cost);
  summary.baseline7dMedianCny = median(baselineCosts);
  summary.baseline7dDays = baselineCosts.length;

  const totalKnownCost = summaryMetrics.knownCostCny;
  const distribution = {
    byAccount: dimension(selectedRows, base => String(base.accountKey), base => String(base.accountLabel), PROBE_COST_TOP_N, totalKnownCost),
    byGroup: dimension(selectedRows, base => String(base.groupKey), base => String(base.groupLabel), PROBE_COST_TOP_N, totalKnownCost),
    byPlatform: dimension(selectedRows, base => String(base.platformKey), base => String(base.platformLabel), PROBE_COST_TOP_N, totalKnownCost),
    byModel: dimension(selectedRows, base => String(base.modelKey), base => String(base.modelLabel), PROBE_COST_TOP_N, totalKnownCost),
    byUpstream: dimension(selectedRows, base => String(base.upstreamKey), base => String(base.upstreamLabel), PROBE_COST_TOP_N, totalKnownCost),
  };

  // Judge the latest finished day. Today's bucket is partial, so comparing it with a
  // full-day budget would understate the cost; the partial day stays visible in days[].
  const evaluation = [...dayReports].reverse().find(day => day.dayComplete && day.requests > 0)
    ?? dayReports.at(-1) ?? null;
  const dailyBudgetCny = config.observability?.probeCostDailyBudgetCny ?? null;
  const trendFactor = config.observability?.probeCostTrendFactor ?? null;
  const evaluationCostCny = evaluation?.costCny ?? null;
  const evaluationKnownCny = evaluation?.knownCostCny ?? null;
  const evaluationCoverage = evaluation?.coveragePercent ?? null;
  // Known cost is a hard lower bound; scaling by coverage gives a conservative upper
  // estimate. Engage a verdict only when that bound settles it, never by inventing cost.
  const evaluationEstimatedCny = evaluationKnownCny !== null && evaluationCoverage !== null && evaluationCoverage > 0
    ? round(evaluationKnownCny / evaluationCoverage * 100) : null;
  const evaluationBasisCny = evaluationCostCny ?? evaluationEstimatedCny ?? evaluationKnownCny;
  const baselineMedianCny = summary.baseline7dMedianCny;
  const trendThresholdCny = baselineMedianCny !== null && trendFactor !== null ? round(baselineMedianCny * trendFactor) : null;
  const exceeds = (threshold: number | null) => threshold === null || evaluationKnownCny === null ? null
    : evaluationKnownCny > threshold ? true
      : evaluationEstimatedCny !== null && evaluationEstimatedCny <= threshold ? false : null;
  const overBudget = exceeds(dailyBudgetCny);
  const trendExceeded = exceeds(trendThresholdCny);
  let status: "exceeded" | "within" | "insufficient_data" = "insufficient_data";
  if (overBudget === true || trendExceeded === true) status = "exceeded";
  else if (evaluation !== null && (dailyBudgetCny !== null || trendThresholdCny !== null)
    && (overBudget === false || dailyBudgetCny === null)
    && (trendExceeded === false || trendThresholdCny === null)) status = "within";
  const recommendations = status !== "exceeded" ? [] : [
    { code:"reduce-frequency", title:"降低探活频率", action:"将非关键账号的轮次或扫描频率下调 20%，优先保留刚失败和刚切号账号。", expectedSavingPercent:20 },
    { code:"improve-cache", title:"提高探活缓存命中", action:"复用探活 Prompt 前缀并排查重复探活，减少每轮重复的输入 token。", expectedSavingPercent:15 },
    { code:"shorten-prompt", title:"缩短探活 Prompt", action:"压缩探活系统提示和上下文，只保留连通性判定所需字段。", expectedSavingPercent:10 },
    { code:"cheaper-route", title:"改用更便宜模型或上游", action:"按 Top 模型与上游分布，把非关键探活切到低成本模型或更低单价上游。", expectedSavingPercent:20 },
    { code:"retry-control", title:"治理失败重试与重复请求", action:"核对超时后的重复探活和失败重试，避免同一账号同轮重复计费。", expectedSavingPercent:10 },
    { code:"isolation-audit", title:"核对探活账号分组隔离", action:"确认探活 Key、用户和分组均隔离，避免真实用户流量混入而低估或高估成本。", expectedSavingPercent:0 },
  ].map(item => ({ ...item, estimatedSavingCny: evaluationBasisCny === null ? null : round(evaluationBasisCny * item.expectedSavingPercent / 100) }));

  return {
    ok: true,
    asOf: options.asOf,
    timezone: options.timezone,
    days: dayReports,
    summary,
    distribution,
    coverage: {
      knownRecords: summaryMetrics.knownRecords,
      missingRecords: summaryMetrics.missingRecords,
      coveragePercent: summary.coveragePercent,
      complete: summary.complete,
      missingReasons: summary.missingReasons,
    },
    budget: {
      dailyBudgetCny,
      trendFactor,
      evaluationDay: evaluation?.day ?? null,
      evaluationDayComplete: evaluation?.dayComplete ?? null,
      evaluationCostCny,
      evaluationKnownCostCny: evaluationKnownCny,
      evaluationEstimatedCostCny: evaluationEstimatedCny,
      evaluationCoveragePercent: evaluationCoverage,
      evaluationBasis: evaluationCostCny !== null ? "exact" : evaluationEstimatedCny !== null ? "estimated" : "known_only",
      baseline7dMedianCny: baselineMedianCny,
      baseline7dDays: summary.baseline7dDays,
      trendThresholdCny,
      overBudget,
      trendExceeded,
      status,
      recommendations,
      recommendationsAdditive: false,
      recommendationBasis: "预计节省按评估日成本（含覆盖率折算）估算，优化项可能重叠，不可直接相加。",
      policy: dailyBudgetCny === null
        ? "未配置每日预算；只按趋势阈值判断，实测基线待裁决建议值。"
        : "每日预算和趋势阈值均来自 owning YAML。",
    },
    valuesPrinted: false,
  };
}
