import { DateTime } from "luxon";
import type { AppConfig } from "./config";
import type { Sub2ApiReadClient, Sub2ApiReadPriority } from "./sub2api-read-executor";
import { parseImpactWindow, type ImpactWindow } from "./user-impact-database";

type Row = Record<string, unknown>;

const MAX_ACCOUNT_IDS = 100;

const accountBatchEconomicsSql = `
WITH selected_accounts AS (
  SELECT DISTINCT unnest(string_to_array($1::text, ',')::bigint[]) AS account_id
),
account_scope AS (
  SELECT selected.account_id, account.id IS NOT NULL AS matched
  FROM selected_accounts selected
  LEFT JOIN accounts account
    ON account.id = selected.account_id
   AND account.deleted_at IS NULL
),
usage_totals AS (
  SELECT
    usage.account_id,
    COUNT(*)::bigint AS request_count,
    COALESCE(SUM(usage.input_tokens + usage.output_tokens), 0)::bigint AS token_count,
    COALESCE(SUM(usage.actual_cost), 0)::numeric AS api_amount_usd,
    MIN(usage.created_at) AS first_used_at,
    MAX(usage.created_at) AS last_used_at
  FROM usage_logs usage
  JOIN account_scope scope
    ON scope.account_id = usage.account_id
   AND scope.matched
  WHERE usage.created_at >= $2::timestamptz
    AND usage.created_at < $3::timestamptz
  GROUP BY usage.account_id
)
SELECT
  COUNT(*)::int AS selected_account_count,
  COUNT(*) FILTER (WHERE scope.matched)::int AS matched_account_count,
  COALESCE(
    ARRAY_AGG(scope.account_id ORDER BY scope.account_id)
      FILTER (WHERE NOT scope.matched),
    '{}'::bigint[]
  ) AS missing_account_ids,
  COALESCE((SELECT COUNT(*) FROM usage_totals), 0)::int AS usage_account_count,
  COALESCE((SELECT SUM(request_count) FROM usage_totals), 0)::bigint AS request_count,
  COALESCE((SELECT SUM(token_count) FROM usage_totals), 0)::bigint AS token_count,
  COALESCE((SELECT SUM(api_amount_usd) FROM usage_totals), 0)::numeric AS api_amount_usd,
  (SELECT MIN(first_used_at) FROM usage_totals) AS first_used_at,
  (SELECT MAX(last_used_at) FROM usage_totals) AS last_used_at
FROM account_scope scope
`;

export interface AccountEconomicsWindowInput {
  day?: string | null;
  start?: string | null;
  end?: string | null;
}

export interface AccountBatchEconomicsInput extends AccountEconomicsWindowInput {
  accountIds: number[];
  costCny: number;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeAccountIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACCOUNT_IDS) {
    throw new Error(`accountIds must contain 1 to ${MAX_ACCOUNT_IDS} stable IDs`);
  }
  const ids = value.map(positiveInteger);
  if (ids.some((id) => id === null)) throw new Error("accountIds must contain only positive integers");
  const normalized = ids as number[];
  if (new Set(normalized).size !== normalized.length) throw new Error("accountIds must be unique");
  return [...normalized].sort((left, right) => left - right);
}

export function parseAccountIdSelector(value: string): number[] {
  const ids: number[] = [];
  for (const token of value.split(",")) {
    const item = token.trim();
    const range = /^(\d+)-(\d+)$/u.exec(item);
    if (range) {
      const start = positiveInteger(range[1]);
      const end = positiveInteger(range[2]);
      if (start === null || end === null || end < start) throw new Error("--accounts ranges must be ascending positive stable IDs");
      if (end - start + 1 > MAX_ACCOUNT_IDS) throw new Error(`--accounts accepts at most ${MAX_ACCOUNT_IDS} stable IDs`);
      for (let id = start; id <= end; id += 1) ids.push(id);
    } else {
      const id = positiveInteger(item);
      if (id === null) throw new Error("--accounts must contain stable IDs or ascending ranges");
      ids.push(id);
    }
    if (ids.length > MAX_ACCOUNT_IDS) throw new Error(`--accounts accepts at most ${MAX_ACCOUNT_IDS} stable IDs`);
  }
  return normalizeAccountIds(ids);
}

export function parseAccountEconomicsWindow(
  input: AccountEconomicsWindowInput,
  timezone: string,
): ImpactWindow {
  const day = input.day?.trim() || null;
  const start = input.start?.trim() || null;
  const end = input.end?.trim() || null;
  if (day !== null) {
    if (start !== null || end !== null) throw new Error("--day cannot be combined with --start or --end");
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error("--day must be YYYY-MM-DD");
    const startAt = DateTime.fromISO(day, { zone: timezone }).startOf("day");
    if (!startAt.isValid || startAt.toISODate() !== day) throw new Error("--day must be a valid calendar date");
    return parseImpactWindow(startAt.toISO()!, startAt.plus({ days: 1 }).toISO()!, timezone);
  }
  if (start === null || end === null) throw new Error("provide --day or both --start and --end");
  return parseImpactWindow(start, end, timezone);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integerArray(value: unknown): number[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.replace(/^\{|\}$/gu, "").split(",").filter(Boolean)
      : [];
  return values.map(positiveInteger).filter((item): item is number => item !== null);
}

function localTime(value: unknown, timezone: string): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date
    ? DateTime.fromJSDate(value)
    : DateTime.fromISO(String(value), { setZone: true });
  return parsed.isValid ? parsed.setZone(timezone).toISO() : null;
}

function rounded(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

export async function collectAccountBatchEconomics(
  config: AppConfig,
  reads: Sub2ApiReadClient,
  input: AccountBatchEconomicsInput,
  priority: Sub2ApiReadPriority = "manual",
): Promise<Row> {
  const accountIds = normalizeAccountIds(input.accountIds);
  if (!Number.isFinite(input.costCny) || input.costCny <= 0) throw new Error("costCny must be a positive number");
  const window = parseAccountEconomicsWindow(input, config.monitor.timezone);
  const startedAt = performance.now();
  const query = await reads.query<Row>({
    key: JSON.stringify(["accounts.economics", accountIds, window.startUtc, window.endUtc]),
    kind: "accounts.economics",
    sql: accountBatchEconomicsSql,
    parameters: [accountIds.join(","), window.startUtc, window.endUtc],
    priority,
    cacheMode: "prefer-cache",
  });
  const row = query.rows[0] ?? {};
  const selectedAccountCount = number(row.selected_account_count);
  const matchedAccountCount = number(row.matched_account_count);
  const apiAmountUsd = number(row.api_amount_usd);
  const missingAccountIds = integerArray(row.missing_account_ids);
  const complete = selectedAccountCount === accountIds.length
    && matchedAccountCount === accountIds.length
    && missingAccountIds.length === 0
    && apiAmountUsd > 0;
  return {
    ok: true,
    complete,
    mode: "account-batch-economics-postgresql",
    window,
    accountIds,
    selectedAccountCount,
    matchedAccountCount,
    usageAccountCount: number(row.usage_account_count),
    missingAccountCount: missingAccountIds.length,
    missingAccountIds,
    requestCount: number(row.request_count),
    tokenCount: number(row.token_count),
    apiAmountUsd: rounded(apiAmountUsd, 8),
    acquisitionCostCny: rounded(input.costCny, 2),
    cnyPerApiUsd: complete ? rounded(input.costCny / apiAmountUsd, 6) : null,
    incompleteReasons: [
      ...(missingAccountIds.length > 0 ? ["missing_accounts"] : []),
      ...(apiAmountUsd <= 0 ? ["zero_api_amount"] : []),
    ],
    firstUsedAt: localTime(row.first_used_at, window.timezone),
    lastUsedAt: localTime(row.last_used_at, window.timezone),
    databaseQueries: query.cached ? 0 : 1,
    queueDurationMs: query.queueDurationMs,
    queryDurationMs: query.queryDurationMs,
    totalDurationMs: rounded(performance.now() - startedAt, 1),
    queryStartedAt: query.queryStartedAt,
    queryCompletedAt: query.queryCompletedAt,
    deduplicated: query.deduplicated,
    cached: query.cached,
    valuesPrinted: false,
  };
}

export const accountBatchEconomicsQuery = accountBatchEconomicsSql;
