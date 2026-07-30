import type { AppConfig } from "./config";
import { readAccountImportCosts } from "./account-import-cost-ledger";
import { parseAccountEconomicsWindow } from "./account-batch-economics";
import type { Sub2ApiReadClient, Sub2ApiReadPriority } from "./sub2api-read-executor";

type Row = Record<string, unknown>;

export interface ExternalAccountCost {
  accountId: number;
  costCny: number;
}

export interface AccountImportEconomicsInput {
  day: string;
  externalCosts?: ExternalAccountCost[];
}

const importEconomicsSql = `
WITH cost_input AS (
  SELECT account_id, cost_cny
  FROM jsonb_to_recordset($1::jsonb) AS item(account_id bigint, cost_cny numeric)
), account_scope AS (
  SELECT
    cost.account_id,
    cost.cost_cny,
    account.id IS NOT NULL AS matched,
    CASE
      WHEN account.id IS NULL THEN 'missing'
      ELSE COALESCE(NULLIF(LOWER(account.credentials->>'plan_type'), ''), 'unknown')
    END AS plan_type
  FROM cost_input cost
  LEFT JOIN accounts account
    ON account.id = cost.account_id
   AND account.deleted_at IS NULL
), usage_totals AS (
  SELECT
    usage.account_id,
    COUNT(*)::bigint AS request_count,
    COALESCE(SUM(usage.input_tokens + usage.output_tokens), 0)::bigint AS token_count,
    COALESCE(SUM(usage.actual_cost), 0)::numeric AS api_amount_usd,
    MIN(usage.created_at) AS first_used_at,
    MAX(usage.created_at) AS last_used_at
  FROM usage_logs usage
  JOIN account_scope scope ON scope.account_id = usage.account_id AND scope.matched
  WHERE usage.created_at >= $2::timestamptz
    AND usage.created_at < $3::timestamptz
  GROUP BY usage.account_id
)
SELECT
  scope.plan_type,
  COUNT(*)::int AS account_count,
  COUNT(*) FILTER (WHERE scope.matched)::int AS matched_account_count,
  COALESCE(ARRAY_AGG(scope.account_id ORDER BY scope.account_id)
    FILTER (WHERE NOT scope.matched), '{}'::bigint[]) AS missing_account_ids,
  COUNT(usage.account_id)::int AS usage_account_count,
  COALESCE(SUM(scope.cost_cny), 0)::numeric AS acquisition_cost_cny,
  COALESCE(SUM(usage.request_count), 0)::bigint AS request_count,
  COALESCE(SUM(usage.token_count), 0)::bigint AS token_count,
  COALESCE(SUM(usage.api_amount_usd), 0)::numeric AS api_amount_usd,
  MIN(usage.first_used_at) AS first_used_at,
  MAX(usage.last_used_at) AS last_used_at
FROM account_scope scope
LEFT JOIN usage_totals usage ON usage.account_id = scope.account_id
GROUP BY scope.plan_type
ORDER BY scope.plan_type
`;

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rounded(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function integerArray(value: unknown): number[] {
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

export function normalizeExternalAccountCosts(value: unknown): ExternalAccountCost[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error("externalCosts must contain at most 100 account costs");
  const result = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("externalCosts entries must be objects");
    const row = item as Record<string, unknown>;
    const accountId = positiveInteger(row.accountId);
    const costCny = Number(row.costCny);
    if (accountId === null || !Number.isFinite(costCny) || costCny <= 0) {
      throw new Error("externalCosts entries require a positive accountId and costCny");
    }
    return { accountId, costCny: rounded(costCny, 2) };
  });
  if (new Set(result.map((item) => item.accountId)).size !== result.length) {
    throw new Error("externalCosts accountId values must be unique");
  }
  return result;
}

function mergeCosts(autoCosts: ExternalAccountCost[], externalCosts: ExternalAccountCost[]) {
  const merged = new Map<number, ExternalAccountCost>();
  const duplicates: number[] = [];
  for (const item of [...autoCosts, ...externalCosts]) {
    const existing = merged.get(item.accountId);
    if (existing) {
      if (existing.costCny !== item.costCny) throw new Error(`account ${item.accountId} has conflicting acquisition costs`);
      duplicates.push(item.accountId);
      continue;
    }
    merged.set(item.accountId, item);
  }
  return { costs: [...merged.values()].sort((a, b) => a.accountId - b.accountId), duplicateAccountIds: [...new Set(duplicates)].sort((a, b) => a - b) };
}

function groupProjection(row: Row, timezone: string) {
  const accountCount = number(row.account_count);
  const matchedAccountCount = number(row.matched_account_count);
  const apiAmountUsd = number(row.api_amount_usd);
  const acquisitionCostCny = number(row.acquisition_cost_cny);
  const missingAccountIds = integerArray(row.missing_account_ids);
  return {
    planType: String(row.plan_type ?? "unknown"),
    accountCount,
    matchedAccountCount,
    usageAccountCount: number(row.usage_account_count),
    missingAccountIds,
    requestCount: number(row.request_count),
    tokenCount: number(row.token_count),
    apiAmountUsd: rounded(apiAmountUsd, 8),
    acquisitionCostCny: rounded(acquisitionCostCny, 2),
    cnyPerApiUsd: apiAmountUsd > 0 ? rounded(acquisitionCostCny / apiAmountUsd, 6) : null,
    complete: matchedAccountCount === accountCount && missingAccountIds.length === 0 && apiAmountUsd > 0,
    firstUsedAt: localTime(row.first_used_at, timezone),
    lastUsedAt: localTime(row.last_used_at, timezone),
  };
}

export async function collectAccountImportEconomics(
  config: AppConfig,
  reads: Sub2ApiReadClient,
  input: AccountImportEconomicsInput,
  priority: Sub2ApiReadPriority = "manual",
): Promise<Row> {
  const window = parseAccountEconomicsWindow({ day: input.day }, config.monitor.timezone);
  const externalCosts = normalizeExternalAccountCosts(input.externalCosts);
  const autoCosts = readAccountImportCosts(config.operations.accountImportLedgerPath)
    .filter((entry) => entry.occurredOn === input.day)
    .map((entry) => ({ accountId: entry.accountId, costCny: entry.amountCny }));
  const merged = mergeCosts(autoCosts, externalCosts);
  if (merged.costs.length === 0) {
    return {
      ok: true, complete: true, mode: "account-import-economics-postgresql", day: input.day, window,
      groups: [], total: { accountCount: 0, matchedAccountCount: 0, usageAccountCount: 0, missingAccountIds: [], requestCount: 0, tokenCount: 0, apiAmountUsd: 0, acquisitionCostCny: 0, cnyPerApiUsd: null, complete: true },
      ledger: { automaticEntries: 0, externalEntries: 0, duplicateAccountIds: [] }, databaseQueries: 0, valuesPrinted: false,
    };
  }
  const startedAt = performance.now();
  const query = await reads.query<Row>({
    key: JSON.stringify(["accounts.import-economics", input.day, merged.costs]),
    kind: "accounts.import-economics",
    sql: importEconomicsSql,
    parameters: [JSON.stringify(merged.costs.map((item) => ({ account_id: item.accountId, cost_cny: item.costCny }))), window.startUtc, window.endUtc],
    priority,
    cacheMode: "bypass-cache",
  });
  const groups = query.rows.map((row) => groupProjection(row, window.timezone));
  const totalApiAmountUsd = groups.reduce((sum, group) => sum + group.apiAmountUsd, 0);
  const totalCostCny = groups.reduce((sum, group) => sum + group.acquisitionCostCny, 0);
  const missingAccountIds = groups.flatMap((group) => group.missingAccountIds).sort((a, b) => a - b);
  const total = {
    accountCount: groups.reduce((sum, group) => sum + group.accountCount, 0),
    matchedAccountCount: groups.reduce((sum, group) => sum + group.matchedAccountCount, 0),
    usageAccountCount: groups.reduce((sum, group) => sum + group.usageAccountCount, 0),
    missingAccountIds,
    requestCount: groups.reduce((sum, group) => sum + group.requestCount, 0),
    tokenCount: groups.reduce((sum, group) => sum + group.tokenCount, 0),
    apiAmountUsd: rounded(totalApiAmountUsd, 8),
    acquisitionCostCny: rounded(totalCostCny, 2),
    cnyPerApiUsd: totalApiAmountUsd > 0 ? rounded(totalCostCny / totalApiAmountUsd, 6) : null,
    complete: groups.every((group) => group.complete),
  };
  return {
    ok: true, complete: total.complete, mode: "account-import-economics-postgresql", day: input.day, window, groups, total,
    ledger: { automaticEntries: autoCosts.length, externalEntries: externalCosts.length, duplicateAccountIds: merged.duplicateAccountIds },
    databaseQueries: query.cached ? 0 : 1, queueDurationMs: query.queueDurationMs, queryDurationMs: query.queryDurationMs,
    totalDurationMs: rounded(performance.now() - startedAt, 1), cached: query.cached, deduplicated: query.deduplicated, valuesPrinted: false,
  };
}

export const accountImportEconomicsQuery = importEconomicsSql;
