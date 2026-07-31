import { expect, test } from "bun:test";
import {
  collectOAuthPoolEconomics,
  mergeOAuthAcquisitionCosts,
  normalizeOAuthRefunds,
  oauthEconomicsSql,
} from "./oauth-economics";
import type { AccountImportCostEntry } from "./account-import-cost-ledger";
import type { AppConfig } from "./config";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

const jsonlEntry = (accountId: number, amountCny: number, batchId = "batch-a"): AccountImportCostEntry => ({
  version: 1, id: `entry-${accountId}`, source: "account-import", currency: "CNY",
  occurredAt: "2026-07-30T00:00:00.000Z", occurredOn: "2026-07-30", period: "2026-07",
  fingerprint: "fingerprint", batchId, planType: "k12", accountId,
  unitCostCny: amountCny, amountCny,
});

test("JSONL is authoritative for the same account while YAML multi-entry costs accumulate", () => {
  const result = mergeOAuthAcquisitionCosts(
    [jsonlEntry(101, 3.3)],
    [
      { kind: "acquisition", accountId: 101, amountCny: 3.3 },
      { kind: "acquisition", accountId: 15, amountCny: 1300 },
      { kind: "acquisition", accountId: 15, amountCny: 1300 },
    ],
  );
  expect(result.yamlSuppressedCount).toBe(1);
  expect(result.costs).toEqual(expect.arrayContaining([
    expect.objectContaining({ accountId: 101, costCny: 3.3 }),
    expect.objectContaining({ accountId: 15, costCny: 2600 }),
  ]));
});

test("refunds require declared account scope and reduce each accounting section", async () => {
  const reads = {
    query: async () => ({
      rows: [
        { row_kind: "group", scope: "pool", plan_type: "k12", account_count: 1, matched_cost_account_count: 1, missing_cost_account_count: 0, present_account_count: 1, orphaned_account_count: 0, account_ids: [101], usage_account_count: 1, acquisition_cost_cny: 3.3, request_count: 2, token_count: 30, api_amount_usd: 10, first_used_at: "2026-07-30T00:00:00.000Z", last_used_at: "2026-07-30T01:00:00.000Z" },
        { row_kind: "group", scope: "archived", plan_type: "k12", account_count: 1, matched_cost_account_count: 1, missing_cost_account_count: 0, present_account_count: 1, orphaned_account_count: 0, account_ids: [102], usage_account_count: 1, acquisition_cost_cny: 3.3, request_count: 1, token_count: 20, api_amount_usd: 5, first_used_at: "2026-07-30T00:00:00.000Z", last_used_at: "2026-07-30T01:00:00.000Z" },
        { row_kind: "health", account_count: 1, normal_count: 1, rate_limited_count: 0, error_count: 0, active_count: 1, schedulable_count: 1, active_rate_limit_count: 0, active_overload_count: 0, active_temp_unschedulable_count: 0 },
      ],
      queueDurationMs: 1, queryDurationMs: 2, totalDurationMs: 3,
      queryStartedAt: "2026-07-30T00:00:00.000Z", queryCompletedAt: "2026-07-30T00:00:01.000Z",
      deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const result = await collectOAuthPoolEconomics(
    { monitor: { timezone: "Asia/Shanghai" } } as AppConfig,
    reads,
    {
      costs: [
        { accountId: 101, costCny: 3.3, planType: "k12", batchIds: ["batch-a"] },
        { accountId: 102, costCny: 3.3, planType: "k12", batchIds: ["batch-a"] },
      ],
      refunds: normalizeOAuthRefunds([{ id: "refund-a", kind: "procurement-refund", amountCny: 3.3, accountIds: [101], batchId: "batch-a", planType: "k12" }]),
      ledger: {},
    },
  );
  const pool = result.pool as { total: Record<string, unknown> };
  const archived = result.archived as { total: Record<string, unknown> };
  expect(pool.total).toEqual(expect.objectContaining({ netAcquisitionCostCny: 0, apiAmountUsd: 10, cnyPerApiUsd: 0 }));
  expect(archived.total).toEqual(expect.objectContaining({ netAcquisitionCostCny: 3.3, apiAmountUsd: 5, cnyPerApiUsd: 0.66 }));
  expect(result.health).toMatchObject({ normalCount: 1, rateLimitedCount: 0, errorCount: 0, probeStarted: false });
});

test("OAuth economics SQL uses current openai/oauth rows, all history, and runtime state fields", () => {
  expect(oauthEconomicsSql).toContain("a.deleted_at IS NULL");
  expect(oauthEconomicsSql).toContain("LOWER(a.platform) = 'openai'");
  expect(oauthEconomicsSql).toContain("LOWER(a.type) = 'oauth'");
  expect(oauthEconomicsSql).toContain("excluded_accounts");
  expect(oauthEconomicsSql).toContain("$3::text");
  expect(oauthEconomicsSql).toContain("FROM usage_logs usage");
  expect(oauthEconomicsSql).toContain("rate_limit_reset_at");
  expect(oauthEconomicsSql).toContain("schedulable");
  expect(oauthEconomicsSql).toContain("NOW()");
  expect(oauthEconomicsSql).not.toContain("access_token");
  expect(oauthEconomicsSql).not.toContain("refresh_token");
});

test("passes configured pool exclusions to the single queued query", async () => {
  let parameters: unknown[] | undefined;
  const reads = {
    query: async (request: { parameters: unknown[] }) => {
      parameters = request.parameters;
      return {
        rows: [{
          row_kind: "health", account_count: 0, normal_count: 0, rate_limited_count: 0, error_count: 0,
          active_count: 0, schedulable_count: 0, active_rate_limit_count: 0, active_overload_count: 0,
          active_temp_unschedulable_count: 0,
        }],
        queueDurationMs: 1, queryDurationMs: 1, totalDurationMs: 1,
        queryStartedAt: "2026-07-30T00:00:00.000Z", queryCompletedAt: "2026-07-30T00:00:00.001Z",
        deduplicated: false, cached: false,
      };
    },
  } as unknown as Sub2ApiReadClient;
  const result = await collectOAuthPoolEconomics(
    { monitor: { timezone: "Asia/Shanghai" } } as AppConfig,
    reads,
    { costs: [], refunds: [], excludedAccountIds: [15, 15], ledger: {} },
  );
  expect(parameters?.[2]).toBe("15");
  expect(result.exclusions).toEqual({ accountIds: [15], count: 1 });
});

test("refund amount cannot exceed the declared batch cost", async () => {
  const reads = { query: async () => { throw new Error("query must not start"); } } as unknown as Sub2ApiReadClient;
  await expect(collectOAuthPoolEconomics(
    { monitor: { timezone: "Asia/Shanghai" } } as AppConfig,
    reads,
    {
      costs: [{ accountId: 101, costCny: 3.3, planType: "k12", batchIds: ["batch-a"] }],
      refunds: normalizeOAuthRefunds([{ id: "refund-a", kind: "procurement-refund", amountCny: 3.31, accountIds: [101], batchId: "batch-a", planType: "k12" }]),
      ledger: {},
    },
  )).rejects.toThrow("超过对应批次采购成本");
});
