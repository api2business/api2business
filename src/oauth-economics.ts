import type { AppConfig, OAuthIdealApiUsdPerAccount, OAuthPlanType } from "./config";
import type { AccountImportCostEntry } from "./account-import-cost-ledger";
import type { Sub2ApiReadClient, Sub2ApiReadPriority } from "./sub2api-read-executor";

type Row = Record<string, unknown>;

export interface OAuthAcquisitionCost {
  accountId: number;
  costCny: number;
  planType: OAuthPlanType | null;
  batchIds: string[];
}

export interface OAuthProcurementRefund {
  id: string;
  amountCny: number;
  accountIds: number[];
  batchId: string | null;
  planType: OAuthPlanType | null;
}

interface CostRecord {
  accountId: number;
  amountCny: number;
  planType: OAuthPlanType | null;
  batchId: string | null;
  source: "jsonl" | "yaml";
}

const oauthEconomicsSql = `
WITH cost_input AS (
  SELECT account_id, cost_cny
  FROM unnest(
    COALESCE(string_to_array(NULLIF($1::text, ''), ',')::bigint[], '{}'::bigint[]),
    COALESCE(string_to_array(NULLIF($2::text, ''), ',')::numeric[], '{}'::numeric[])
  ) AS item(account_id, cost_cny)
), excluded_accounts AS (
  SELECT account_id
  FROM unnest(
    COALESCE(string_to_array(NULLIF($3::text, ''), ',')::bigint[], '{}'::bigint[])
  ) AS item(account_id)
), current_accounts AS (
  SELECT
    a.id,
    COALESCE(NULLIF(LOWER(a.credentials->>'plan_type'), ''), 'unknown') AS plan_type,
    a.status,
    COALESCE(a.schedulable, false) AS schedulable,
    a.rate_limit_reset_at,
    a.overload_until,
    a.temp_unschedulable_until,
    CASE
      WHEN a.rate_limit_reset_at IS NOT NULL
        AND a.rate_limit_reset_at > NOW() THEN 'rate_limited'
      WHEN a.status = 'active'
        AND COALESCE(a.schedulable, false)
        AND (a.overload_until IS NULL OR a.overload_until <= NOW())
        AND (a.temp_unschedulable_until IS NULL OR a.temp_unschedulable_until <= NOW())
        THEN 'normal'
      ELSE 'error'
    END AS state_bucket
  FROM accounts a
  WHERE a.deleted_at IS NULL
    AND LOWER(a.platform) = 'openai'
    AND LOWER(a.type) = 'oauth'
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts excluded WHERE excluded.account_id = a.id)
), cost_scope AS (
  SELECT
    cost.account_id,
    cost.cost_cny,
    current_account.id IS NOT NULL AS is_current,
    account.id IS NOT NULL AS account_exists,
    CASE
      WHEN current_account.id IS NOT NULL THEN current_account.plan_type
      ELSE COALESCE(NULLIF(LOWER(account.credentials->>'plan_type'), ''), 'unknown')
    END AS plan_type
  FROM cost_input cost
  LEFT JOIN current_accounts current_account ON current_account.id = cost.account_id
  LEFT JOIN accounts account ON account.id = cost.account_id
  WHERE NOT EXISTS (SELECT 1 FROM excluded_accounts excluded WHERE excluded.account_id = cost.account_id)
), usage_targets AS (
  SELECT id AS account_id FROM current_accounts
  UNION
  SELECT account_id FROM cost_scope WHERE NOT is_current
), usage_totals AS (
  SELECT
    usage.account_id,
    COUNT(*)::bigint AS request_count,
    COALESCE(SUM(usage.input_tokens + usage.output_tokens), 0)::bigint AS token_count,
    COALESCE(SUM(usage.actual_cost), 0)::numeric AS api_amount_usd,
    MIN(usage.created_at) AS first_used_at,
    MAX(usage.created_at) AS last_used_at
  FROM usage_logs usage
  JOIN usage_targets target ON target.account_id = usage.account_id
  GROUP BY usage.account_id
), group_rows AS (
  SELECT
    'pool'::text AS scope,
    current_account.plan_type,
    COUNT(*)::int AS account_count,
    COUNT(cost.account_id)::int AS matched_cost_account_count,
    COUNT(*) FILTER (WHERE cost.account_id IS NULL)::int AS missing_cost_account_count,
    COUNT(*)::int AS present_account_count,
    0::int AS orphaned_account_count,
    ARRAY_AGG(current_account.id ORDER BY current_account.id) AS account_ids,
    ARRAY_AGG(current_account.id ORDER BY current_account.id) FILTER (WHERE cost.account_id IS NULL) AS missing_cost_account_ids,
    COUNT(usage.account_id)::int AS usage_account_count,
    COALESCE(SUM(cost.cost_cny), 0)::numeric AS acquisition_cost_cny,
    COALESCE(SUM(usage.request_count), 0)::bigint AS request_count,
    COALESCE(SUM(usage.token_count), 0)::bigint AS token_count,
    COALESCE(SUM(usage.api_amount_usd), 0)::numeric AS api_amount_usd,
    COALESCE(
      SUM(usage.api_amount_usd) FILTER (
        WHERE current_account.state_bucket IN ('rate_limited', 'error')
      ),
      0
    )::numeric AS unavailable_api_amount_usd,
    MIN(usage.first_used_at) AS first_used_at,
    MAX(usage.last_used_at) AS last_used_at,
    COUNT(*) FILTER (WHERE current_account.state_bucket = 'normal')::int AS normal_count,
    COUNT(*) FILTER (WHERE current_account.state_bucket = 'rate_limited')::int AS rate_limited_count,
    COUNT(*) FILTER (WHERE current_account.state_bucket = 'error')::int AS error_count
  FROM current_accounts current_account
  LEFT JOIN cost_scope cost ON cost.account_id = current_account.id
  LEFT JOIN usage_totals usage ON usage.account_id = current_account.id
  GROUP BY current_account.plan_type
  UNION ALL
  SELECT
    'archived'::text AS scope,
    cost.plan_type,
    COUNT(*)::int AS account_count,
    COUNT(*)::int AS matched_cost_account_count,
    0::int AS missing_cost_account_count,
    COUNT(*) FILTER (WHERE cost.account_exists)::int AS present_account_count,
    COUNT(*) FILTER (WHERE NOT cost.account_exists)::int AS orphaned_account_count,
    ARRAY_AGG(cost.account_id ORDER BY cost.account_id) AS account_ids,
    ARRAY[]::bigint[] AS missing_cost_account_ids,
    COUNT(usage.account_id)::int AS usage_account_count,
    COALESCE(SUM(cost.cost_cny), 0)::numeric AS acquisition_cost_cny,
    COALESCE(SUM(usage.request_count), 0)::bigint AS request_count,
    COALESCE(SUM(usage.token_count), 0)::bigint AS token_count,
    COALESCE(SUM(usage.api_amount_usd), 0)::numeric AS api_amount_usd,
    0::numeric AS unavailable_api_amount_usd,
    MIN(usage.first_used_at) AS first_used_at,
    MAX(usage.last_used_at) AS last_used_at,
    0::int AS normal_count,
    0::int AS rate_limited_count,
    0::int AS error_count
  FROM cost_scope cost
  LEFT JOIN usage_totals usage ON usage.account_id = cost.account_id
  WHERE NOT cost.is_current
  GROUP BY cost.plan_type
), health_scope AS (
  SELECT
    current_account.*
  FROM current_accounts current_account
), health_row AS (
  SELECT
    COUNT(*)::int AS account_count,
    COUNT(*) FILTER (WHERE state_bucket = 'normal')::int AS normal_count,
    COUNT(*) FILTER (WHERE state_bucket = 'rate_limited')::int AS rate_limited_count,
    COUNT(*) FILTER (WHERE state_bucket = 'error')::int AS error_count,
    COUNT(*) FILTER (WHERE status = 'active')::int AS active_count,
    COUNT(*) FILTER (WHERE schedulable)::int AS schedulable_count,
    COUNT(*) FILTER (WHERE rate_limit_reset_at IS NOT NULL AND rate_limit_reset_at > NOW())::int AS active_rate_limit_count,
    COUNT(*) FILTER (WHERE overload_until IS NOT NULL AND overload_until > NOW())::int AS active_overload_count,
    COUNT(*) FILTER (WHERE temp_unschedulable_until IS NOT NULL AND temp_unschedulable_until > NOW())::int AS active_temp_unschedulable_count
  FROM health_scope
)
SELECT
  'group'::text AS row_kind,
  rows.scope,
  rows.plan_type,
  rows.account_count,
  rows.matched_cost_account_count,
  rows.missing_cost_account_count,
  rows.present_account_count,
  rows.orphaned_account_count,
  rows.account_ids,
  rows.missing_cost_account_ids,
  rows.usage_account_count,
  rows.acquisition_cost_cny,
  rows.request_count,
  rows.token_count,
  rows.api_amount_usd,
  rows.unavailable_api_amount_usd,
  rows.first_used_at,
  rows.last_used_at,
  rows.normal_count,
  rows.rate_limited_count,
  rows.error_count,
  NULL::int AS active_count,
  NULL::int AS schedulable_count,
  NULL::int AS active_rate_limit_count,
  NULL::int AS active_overload_count,
  NULL::int AS active_temp_unschedulable_count
FROM group_rows rows
UNION ALL
SELECT
  'health'::text AS row_kind,
  'pool'::text AS scope,
  NULL::text AS plan_type,
  health.account_count,
  NULL::int,
  NULL::int,
  NULL::int,
  NULL::int,
  NULL::bigint[],
  NULL::bigint[],
  NULL::int,
  NULL::numeric,
  NULL::bigint,
  NULL::bigint,
  NULL::numeric,
  NULL::numeric,
  NULL::timestamptz,
  NULL::timestamptz,
  health.normal_count,
  health.rate_limited_count,
  health.error_count,
  health.active_count,
  health.schedulable_count,
  health.active_rate_limit_count,
  health.active_overload_count,
  health.active_temp_unschedulable_count
FROM health_row health
`;

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function rounded(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function arrayNumbers(value: unknown): number[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.replace(/^\{|\}$/gu, "").split(",").filter(Boolean) : [];
  return values.map(positiveInteger).filter((item): item is number => item !== null);
}

function localTime(value: unknown, timezone: string): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString("sv-SE", { timeZone: timezone }).replace(" ", "T");
}

function planType(value: unknown): OAuthPlanType | null {
  return value === "k12" || value === "plus" || value === "free" || value === "team" ? value : null;
}

function yamlAccountId(value: unknown): number | null {
  return positiveInteger(value);
}

export function mergeOAuthAcquisitionCosts(
  importEntries: AccountImportCostEntry[],
  yamlCosts: Array<Record<string, unknown>>,
): { costs: OAuthAcquisitionCost[]; jsonlEntryCount: number; yamlEntryCount: number; yamlSuppressedCount: number } {
  const jsonlAccountIds = new Set(importEntries.map((entry) => entry.accountId));
  const records: CostRecord[] = importEntries.map((entry) => ({
    accountId: entry.accountId,
    amountCny: entry.amountCny,
    planType: entry.planType,
    batchId: entry.batchId,
    source: "jsonl",
  }));
  let yamlEntryCount = 0;
  let yamlSuppressedCount = 0;
  for (const row of yamlCosts) {
    if (row.kind !== "acquisition") continue;
    const accountId = yamlAccountId(row.accountId);
    const amountCny = Number(row.amountCny);
    if (accountId === null || !Number.isFinite(amountCny) || amountCny <= 0) continue;
    yamlEntryCount += 1;
    if (jsonlAccountIds.has(accountId)) {
      yamlSuppressedCount += 1;
      continue;
    }
    records.push({ accountId, amountCny, planType: planType(row.planType), batchId: null, source: "yaml" });
  }
  const byAccount = new Map<number, OAuthAcquisitionCost>();
  for (const record of records) {
    const existing = byAccount.get(record.accountId);
    if (existing) {
      existing.costCny = money(existing.costCny + record.amountCny);
      if (record.planType !== null) {
        if (existing.planType !== null && existing.planType !== record.planType) {
          throw new Error(`账号 ${record.accountId} 的采购记录计划类型冲突`);
        }
        existing.planType = record.planType;
      }
      if (record.batchId && !existing.batchIds.includes(record.batchId)) existing.batchIds.push(record.batchId);
      continue;
    }
    byAccount.set(record.accountId, {
      accountId: record.accountId,
      costCny: money(record.amountCny),
      planType: record.planType,
      batchIds: record.batchId ? [record.batchId] : [],
    });
  }
  return {
    costs: [...byAccount.values()].sort((left, right) => left.accountId - right.accountId),
    jsonlEntryCount: importEntries.length,
    yamlEntryCount,
    yamlSuppressedCount,
  };
}

export function normalizeOAuthRefunds(value: Array<Record<string, unknown>>): OAuthProcurementRefund[] {
  return value.filter((row) => row.kind === "procurement-refund").map((row, index) => {
    const id = typeof row.id === "string" && row.id.trim() ? row.id : `refund-${index + 1}`;
    const amountCny = Number(row.amountCny);
    const accountIds = Array.isArray(row.accountIds)
      ? row.accountIds.map(positiveInteger).filter((item): item is number => item !== null)
      : [];
    if (!Number.isFinite(amountCny) || amountCny <= 0 || accountIds.length === 0) {
      throw new Error(`采购退款 ${id} 缺少有效金额或 accountIds`);
    }
    const uniqueAccountIds = [...new Set(accountIds)].sort((left, right) => left - right);
    return {
      id,
      amountCny: money(amountCny),
      accountIds: uniqueAccountIds,
      batchId: typeof row.batchId === "string" && row.batchId.trim() ? row.batchId : null,
      planType: planType(row.planType),
    };
  });
}

function refundAllocations(
  refunds: OAuthProcurementRefund[],
  costs: OAuthAcquisitionCost[],
): { byAccount: Map<number, number>; totalCny: number } {
  const costsByAccount = new Map(costs.map((cost) => [cost.accountId, cost]));
  const byAccount = new Map<number, number>();
  let totalCny = 0;
  for (const refund of refunds) {
    const batchCosts = refund.accountIds.map((accountId) => {
      const cost = costsByAccount.get(accountId);
      if (!cost) throw new Error(`采购退款 ${refund.id} 引用了缺少采购成本的账号`);
      if (refund.batchId && cost.batchIds.length > 0 && !cost.batchIds.includes(refund.batchId)) {
        throw new Error(`采购退款 ${refund.id} 与账号采购批次不一致`);
      }
      if (refund.planType && cost.planType && refund.planType !== cost.planType) {
        throw new Error(`采购退款 ${refund.id} 与账号计划类型不一致`);
      }
      return cost;
    });
    const gross = batchCosts.reduce((sum, cost) => sum + cost.costCny, 0);
    if (refund.amountCny > gross + 0.01) throw new Error(`采购退款 ${refund.id} 超过对应批次采购成本`);
    let allocated = 0;
    batchCosts.forEach((cost, index) => {
      const amount = index === batchCosts.length - 1
        ? money(refund.amountCny - allocated)
        : money(refund.amountCny * cost.costCny / gross);
      allocated = money(allocated + amount);
      byAccount.set(cost.accountId, money((byAccount.get(cost.accountId) ?? 0) + amount));
    });
    totalCny = money(totalCny + refund.amountCny);
  }
  return { byAccount, totalCny };
}

function projectGroup(
  row: Row,
  timezone: string,
  refunds: Map<number, number>,
  idealApiUsdPerAccount: OAuthIdealApiUsdPerAccount,
) {
  const accountIds = arrayNumbers(row.account_ids);
  const rowPlanType = String(row.plan_type ?? "unknown");
  const configuredPlanType = planType(rowPlanType);
  const idealApiUsdPerAccountValue = configuredPlanType === null
    ? null
    : idealApiUsdPerAccount[configuredPlanType];
  const accountCount = number(row.account_count);
  const grossAcquisitionCostCny = money(number(row.acquisition_cost_cny));
  const procurementRefundCny = money(accountIds.reduce((sum, id) => sum + (refunds.get(id) ?? 0), 0));
  const netAcquisitionCostCny = money(Math.max(0, grossAcquisitionCostCny - procurementRefundCny));
  const apiAmountUsd = rounded(number(row.api_amount_usd), 8);
  const unavailableApiAmountUsd = rounded(number(row.unavailable_api_amount_usd), 8);
  const missingCostAccountCount = number(row.missing_cost_account_count);
  const missingCostAccountIds = arrayNumbers(row.missing_cost_account_ids);
  const normalCount = number(row.normal_count);
  const rateLimitedCount = number(row.rate_limited_count);
  const errorCount = number(row.error_count);
  const statusCount = normalCount + rateLimitedCount + errorCount;
  const statusCoverageComplete = row.scope === "pool" && statusCount === accountCount;
  const statusAdjusted = statusCoverageComplete && rateLimitedCount + errorCount > 0;
  const expectedApiAmountUsd = idealApiUsdPerAccountValue === null
    ? statusCoverageComplete && normalCount === 0 ? unavailableApiAmountUsd : null
    : statusCoverageComplete
      ? rounded(normalCount * idealApiUsdPerAccountValue + unavailableApiAmountUsd, 8)
      : rounded(accountCount * idealApiUsdPerAccountValue, 8);
  const expectedOutputBasis = statusAdjusted ? "status-adjusted" : "configured";
  return {
    scope: String(row.scope ?? ""),
    planType: rowPlanType,
    accountCount,
    matchedCostAccountCount: number(row.matched_cost_account_count),
    missingCostAccountCount,
    missingCostAccountIds,
    presentAccountCount: number(row.present_account_count),
    orphanedAccountCount: number(row.orphaned_account_count),
    usageAccountCount: number(row.usage_account_count),
    requestCount: number(row.request_count),
    tokenCount: number(row.token_count),
    apiAmountUsd,
    unavailableApiAmountUsd,
    grossAcquisitionCostCny,
    procurementRefundCny,
    netAcquisitionCostCny,
    acquisitionCostCny: netAcquisitionCostCny,
    averageUnitCostCny: accountCount > 0
      ? rounded(netAcquisitionCostCny / accountCount, 6)
      : null,
    cnyPerApiUsd: apiAmountUsd > 0
      ? rounded(netAcquisitionCostCny / apiAmountUsd, 6)
      : null,
    expectedApiUsdPerAccount: idealApiUsdPerAccountValue,
    expectedApiAmountUsd,
    remainingExpectedApiAmountUsd: expectedApiAmountUsd === null
      ? null
      : rounded(Math.max(0, expectedApiAmountUsd - apiAmountUsd), 8),
    expectedCnyPerApiUsd: expectedApiAmountUsd !== null && expectedApiAmountUsd > 0
      ? rounded(netAcquisitionCostCny / expectedApiAmountUsd, 6)
      : null,
    expectedCostComplete: expectedApiAmountUsd !== null,
    expectedOutputBasis,
    // Keep the old names for existing CLI/API consumers during the field migration.
    idealApiUsdPerAccount: idealApiUsdPerAccountValue,
    idealApiAmountUsd: expectedApiAmountUsd,
    remainingIdealApiAmountUsd: expectedApiAmountUsd === null
      ? null
      : rounded(Math.max(0, expectedApiAmountUsd - apiAmountUsd), 8),
    idealCnyPerApiUsd: expectedApiAmountUsd !== null && expectedApiAmountUsd > 0
      ? rounded(netAcquisitionCostCny / expectedApiAmountUsd, 6)
      : null,
    idealCostComplete: expectedApiAmountUsd !== null,
    normalCount,
    rateLimitedCount,
    errorCount,
    firstUsedAt: localTime(row.first_used_at, timezone),
    lastUsedAt: localTime(row.last_used_at, timezone),
  };
}

function totalProjection(groups: Array<Record<string, unknown>>, scope: string) {
  const scoped = groups.filter((group) => group.scope === scope);
  const apiAmountUsd = scoped.reduce((sum, group) => sum + number(group.apiAmountUsd), 0);
  const gross = scoped.reduce((sum, group) => sum + number(group.grossAcquisitionCostCny), 0);
  const refund = scoped.reduce((sum, group) => sum + number(group.procurementRefundCny), 0);
  const net = scoped.reduce((sum, group) => sum + number(group.netAcquisitionCostCny), 0);
  const missingCostAccountCount = scoped.reduce((sum, group) => sum + number(group.missingCostAccountCount), 0);
  const missingCostAccountIds = [...new Set(scoped.flatMap((group) => arrayNumbers(group.missingCostAccountIds)))].sort((left, right) => left - right);
  const missingExpectedPlanTypes = [...new Set(
    scoped
      .filter((group) => group.expectedApiAmountUsd === null)
      .map((group) => String(group.planType ?? "unknown")),
  )].sort();
  const expectedCostComplete = scoped.length > 0 && missingExpectedPlanTypes.length === 0;
  const expectedApiAmountUsd = expectedCostComplete
    ? rounded(scoped.reduce((sum, group) => sum + number(group.expectedApiAmountUsd), 0), 8)
    : null;
  const unavailableApiAmountUsd = rounded(
    scoped.reduce((sum, group) => sum + number(group.unavailableApiAmountUsd), 0),
    8,
  );
  const expectedOutputBasis = scoped.some((group) => group.expectedOutputBasis === "status-adjusted")
    ? "status-adjusted"
    : "configured";
  const total = {
    scope,
    accountCount: scoped.reduce((sum, group) => sum + number(group.accountCount), 0),
    matchedCostAccountCount: scoped.reduce((sum, group) => sum + number(group.matchedCostAccountCount), 0),
    missingCostAccountCount,
    missingCostAccountIds,
    presentAccountCount: scoped.reduce((sum, group) => sum + number(group.presentAccountCount), 0),
    orphanedAccountCount: scoped.reduce((sum, group) => sum + number(group.orphanedAccountCount), 0),
    usageAccountCount: scoped.reduce((sum, group) => sum + number(group.usageAccountCount), 0),
    requestCount: scoped.reduce((sum, group) => sum + number(group.requestCount), 0),
    tokenCount: scoped.reduce((sum, group) => sum + number(group.tokenCount), 0),
    apiAmountUsd: rounded(apiAmountUsd, 8),
    unavailableApiAmountUsd,
    grossAcquisitionCostCny: money(gross),
    procurementRefundCny: money(refund),
    netAcquisitionCostCny: money(net),
    acquisitionCostCny: money(net),
    cnyPerApiUsd: apiAmountUsd > 0 ? rounded(net / apiAmountUsd, 6) : null,
    expectedApiAmountUsd,
    remainingExpectedApiAmountUsd: expectedApiAmountUsd === null
      ? null
      : rounded(Math.max(0, expectedApiAmountUsd - apiAmountUsd), 8),
    expectedCnyPerApiUsd: expectedApiAmountUsd !== null && expectedApiAmountUsd > 0
      ? rounded(net / expectedApiAmountUsd, 6)
      : null,
    expectedCostComplete,
    missingExpectedPlanTypes,
    expectedOutputBasis,
    // Keep the old names for existing CLI/API consumers during the field migration.
    idealApiAmountUsd: expectedApiAmountUsd,
    remainingIdealApiAmountUsd: expectedApiAmountUsd === null
      ? null
      : rounded(Math.max(0, expectedApiAmountUsd - apiAmountUsd), 8),
    idealCnyPerApiUsd: expectedApiAmountUsd !== null && expectedApiAmountUsd > 0
      ? rounded(net / expectedApiAmountUsd, 6)
      : null,
    idealCostComplete: expectedCostComplete,
    missingIdealPlanTypes: missingExpectedPlanTypes,
    complete: scoped.length > 0 && missingCostAccountCount === 0
      && apiAmountUsd > 0
      && expectedCostComplete,
  };
  return total;
}

export async function collectOAuthPoolEconomics(
  config: AppConfig,
  reads: Sub2ApiReadClient,
  input: {
    costs: OAuthAcquisitionCost[];
    refunds: OAuthProcurementRefund[];
    ledger: Record<string, unknown>;
    excludedAccountIds?: number[];
  },
  priority: Sub2ApiReadPriority = "manual",
): Promise<Row> {
  const allocations = refundAllocations(input.refunds, input.costs);
  const accountIds = input.costs.map((cost) => cost.accountId);
  const costValues = input.costs.map((cost) => cost.costCny);
  const excludedAccountIds = [...new Set(
    (input.excludedAccountIds ?? []).filter((id): id is number => positiveInteger(id) !== null),
  )].sort((left, right) => left - right);
  const startedAt = performance.now();
  const query = await reads.query<Row>({
    key: JSON.stringify(["accounts.oauth-economics", input.costs, input.refunds, excludedAccountIds]),
    kind: "accounts.oauth-economics",
    sql: oauthEconomicsSql,
    parameters: [accountIds.join(","), costValues.join(","), excludedAccountIds.join(",")],
    priority,
    cacheMode: "bypass-cache",
  });
  const groups: Array<Record<string, unknown>> = [];
  let health: Record<string, unknown> = {
    accountCount: 0, normalCount: 0, rateLimitedCount: 0, errorCount: 0,
    activeCount: 0, schedulableCount: 0, activeRateLimitCount: 0,
    activeOverloadCount: 0, activeTempUnschedulableCount: 0,
    probeStarted: false, source: "accounts.status/schedulable/runtime-cooldown-fields",
  };
  for (const row of query.rows) {
    if (row.row_kind === "health") {
      health = {
        accountCount: number(row.account_count),
        normalCount: number(row.normal_count),
        rateLimitedCount: number(row.rate_limited_count),
        errorCount: number(row.error_count),
        activeCount: number(row.active_count),
        schedulableCount: number(row.schedulable_count),
        activeRateLimitCount: number(row.active_rate_limit_count),
        activeOverloadCount: number(row.active_overload_count),
        activeTempUnschedulableCount: number(row.active_temp_unschedulable_count),
        probeStarted: false,
        source: "accounts.status/schedulable/runtime-cooldown-fields",
      };
    } else if (row.row_kind === "group") {
      groups.push(projectGroup(
        row,
        config.monitor.timezone,
        allocations.byAccount,
        config.operations.oauthEconomics.idealApiUsdPerAccount,
      ));
    }
  }
  const poolGroups = groups.filter((group) => group.scope === "pool");
  const archivedGroups = groups.filter((group) => group.scope === "archived");
  const pool = totalProjection(poolGroups, "pool");
  const archived = totalProjection(archivedGroups, "archived");
  const expectedAllComplete = pool.expectedApiAmountUsd !== null
    && (archivedGroups.length === 0 || archived.expectedApiAmountUsd !== null);
  const expectedAllApiAmountUsd = expectedAllComplete
    ? rounded(pool.expectedApiAmountUsd + (archived.expectedApiAmountUsd ?? 0), 8)
    : null;
  const all = {
    accountCount: pool.accountCount + archived.accountCount,
    matchedCostAccountCount: pool.matchedCostAccountCount + archived.matchedCostAccountCount,
    missingCostAccountCount: pool.missingCostAccountCount + archived.missingCostAccountCount,
    missingCostAccountIds: [...new Set([
      ...arrayNumbers(pool.missingCostAccountIds),
      ...arrayNumbers(archived.missingCostAccountIds),
    ])].sort((left, right) => left - right),
    presentAccountCount: pool.presentAccountCount + archived.presentAccountCount,
    orphanedAccountCount: pool.orphanedAccountCount + archived.orphanedAccountCount,
    usageAccountCount: pool.usageAccountCount + archived.usageAccountCount,
    requestCount: pool.requestCount + archived.requestCount,
    tokenCount: pool.tokenCount + archived.tokenCount,
    apiAmountUsd: rounded(pool.apiAmountUsd + archived.apiAmountUsd, 8),
    unavailableApiAmountUsd: rounded(pool.unavailableApiAmountUsd + archived.unavailableApiAmountUsd, 8),
    grossAcquisitionCostCny: money(pool.grossAcquisitionCostCny + archived.grossAcquisitionCostCny),
    procurementRefundCny: money(pool.procurementRefundCny + archived.procurementRefundCny),
    netAcquisitionCostCny: money(pool.netAcquisitionCostCny + archived.netAcquisitionCostCny),
    acquisitionCostCny: money(pool.netAcquisitionCostCny + archived.netAcquisitionCostCny),
    cnyPerApiUsd: pool.apiAmountUsd + archived.apiAmountUsd > 0
      ? rounded((pool.netAcquisitionCostCny + archived.netAcquisitionCostCny) / (pool.apiAmountUsd + archived.apiAmountUsd), 6)
      : null,
    expectedApiAmountUsd: expectedAllApiAmountUsd,
    remainingExpectedApiAmountUsd: expectedAllApiAmountUsd === null
      ? null
      : rounded(
        Math.max(0, expectedAllApiAmountUsd - (pool.apiAmountUsd + archived.apiAmountUsd)),
        8,
      ),
    expectedCnyPerApiUsd: expectedAllApiAmountUsd !== null && expectedAllApiAmountUsd > 0
      ? rounded(
        (pool.netAcquisitionCostCny + archived.netAcquisitionCostCny) / expectedAllApiAmountUsd,
        6,
      )
      : null,
    expectedCostComplete: pool.expectedCostComplete
      && (archivedGroups.length === 0 || archived.expectedCostComplete),
    expectedOutputBasis: archivedGroups.length > 0 && pool.expectedOutputBasis === "status-adjusted"
      ? "mixed"
      : pool.expectedOutputBasis,
    // Keep the old names for existing CLI/API consumers during the field migration.
    idealApiAmountUsd: expectedAllApiAmountUsd,
    remainingIdealApiAmountUsd: expectedAllApiAmountUsd === null
      ? null
      : rounded(
        Math.max(0, expectedAllApiAmountUsd - (pool.apiAmountUsd + archived.apiAmountUsd)),
        8,
      ),
    idealCnyPerApiUsd: expectedAllApiAmountUsd !== null && expectedAllApiAmountUsd > 0
      ? rounded((pool.netAcquisitionCostCny + archived.netAcquisitionCostCny) / expectedAllApiAmountUsd, 6)
      : null,
    idealCostComplete: pool.expectedCostComplete && (archivedGroups.length === 0 || archived.expectedCostComplete),
    missingExpectedPlanTypes: [...new Set([
      ...pool.missingExpectedPlanTypes,
      ...archived.missingExpectedPlanTypes,
    ])].sort(),
    missingIdealPlanTypes: [...new Set([
      ...pool.missingExpectedPlanTypes,
      ...archived.missingExpectedPlanTypes,
    ])].sort(),
    complete: pool.complete && (archivedGroups.length === 0 || archived.complete),
  };
  const missingCostAccountIds = arrayNumbers(all.missingCostAccountIds);
  const missingExpectedPlanTypes = Array.isArray(all.missingExpectedPlanTypes) ? all.missingExpectedPlanTypes : [];
  const warnings: Array<Record<string, unknown>> = [];
  if (missingCostAccountIds.length > 0) {
    warnings.push({
      code: "missing_acquisition_cost",
      message: `有 ${missingCostAccountIds.length} 个 OAuth 账号缺少采购成本记录，综合成本仅按已知池内成本计算`,
      accountIds: missingCostAccountIds,
      missingData: "acquisition_cost_cny",
    });
  }
  if (missingExpectedPlanTypes.length > 0) {
    warnings.push({
      code: "missing_ideal_api_output",
      message: `账号类型 ${missingExpectedPlanTypes.join(", ")} 缺少预期 API 美元产出配置，预期成本暂不计算`,
      planTypes: missingExpectedPlanTypes,
      missingData: "ideal_api_usd_per_account",
    });
  }
  return {
    ok: true,
    complete: pool.complete,
    mode: "oauth-pool-economics-postgresql",
    accountingBasis: "openai-oauth-net-acquisition-cost",
    usageScope: "all-history",
    pool: { groups: poolGroups, total: pool },
    archived: { groups: archivedGroups, total: archived },
    all: { total: all },
    warnings,
    exclusions: { accountIds: excludedAccountIds, count: excludedAccountIds.length },
    groups: poolGroups,
    total: pool,
    health,
    ledger: input.ledger,
    refunds: { count: input.refunds.length, totalCny: allocations.totalCny },
    pagination: { page: 1, pageSize: poolGroups.length || 1, total: poolGroups.length, totalPages: 1 },
    databaseQueries: query.cached ? 0 : 1,
    queueDurationMs: query.queueDurationMs,
    queryDurationMs: query.queryDurationMs,
    totalDurationMs: rounded(performance.now() - startedAt, 1),
    cached: query.cached,
    deduplicated: query.deduplicated,
    valuesPrinted: false,
  };
}

export { oauthEconomicsSql };
