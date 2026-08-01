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

const testConfig = {
  monitor: { timezone: "Asia/Shanghai" },
  operations: {
    oauthEconomics: {
      idealApiUsdPerAccount: { free: 3.5, k12: 20, plus: 140, team: 140 },
    },
  },
} as AppConfig;

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

test("keeps Free import costs in the OAuth accounting input", () => {
  const result = mergeOAuthAcquisitionCosts([{
    ...jsonlEntry(103, 0.5),
    planType: "free",
  }], []);
  expect(result.costs).toEqual([expect.objectContaining({ accountId: 103, costCny: 0.5, planType: "free" })]);
});

test("refunds require declared account scope and reduce each accounting section", async () => {
  const reads = {
    query: async () => ({
      rows: [
        { row_kind: "group", scope: "pool", plan_type: "k12", account_count: 1, matched_cost_account_count: 1, missing_cost_account_count: 0, present_account_count: 1, orphaned_account_count: 0, account_ids: [101], missing_cost_account_ids: [], usage_account_count: 1, acquisition_cost_cny: 3.3, request_count: 2, token_count: 30, api_amount_usd: 10, normal_count: 1, rate_limited_count: 0, error_count: 0, first_used_at: "2026-07-30T00:00:00.000Z", last_used_at: "2026-07-30T01:00:00.000Z" },
        { row_kind: "group", scope: "archived", plan_type: "k12", account_count: 1, matched_cost_account_count: 1, missing_cost_account_count: 0, present_account_count: 1, orphaned_account_count: 0, account_ids: [102], missing_cost_account_ids: [], usage_account_count: 1, acquisition_cost_cny: 3.3, request_count: 1, token_count: 20, api_amount_usd: 5, normal_count: 0, rate_limited_count: 0, error_count: 0, first_used_at: "2026-07-30T00:00:00.000Z", last_used_at: "2026-07-30T01:00:00.000Z" },
        { row_kind: "health", account_count: 1, normal_count: 1, rate_limited_count: 0, error_count: 0, active_count: 1, schedulable_count: 1, active_rate_limit_count: 0, active_overload_count: 0, active_temp_unschedulable_count: 0 },
      ],
      queueDurationMs: 1, queryDurationMs: 2, totalDurationMs: 3,
      queryStartedAt: "2026-07-30T00:00:00.000Z", queryCompletedAt: "2026-07-30T00:00:01.000Z",
      deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const result = await collectOAuthPoolEconomics(
    testConfig,
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
  expect(pool.total).toEqual(expect.objectContaining({
    netAcquisitionCostCny: 0,
    apiAmountUsd: 10,
    cnyPerApiUsd: 0,
    idealApiAmountUsd: 20,
    remainingIdealApiAmountUsd: 10,
    idealCnyPerApiUsd: 0,
  }));
  expect(archived.total).toEqual(expect.objectContaining({
    netAcquisitionCostCny: 3.3,
    apiAmountUsd: 5,
    cnyPerApiUsd: 0.66,
    idealApiAmountUsd: 20,
    remainingIdealApiAmountUsd: 15,
    idealCnyPerApiUsd: 0.165,
  }));
  expect(pool.total).not.toHaveProperty("averageUnitCostCny");
  expect(archived.total).not.toHaveProperty("averageUnitCostCny");
  expect((result.all as { total: Record<string, unknown> }).total).not.toHaveProperty("averageUnitCostCny");
  expect((result.pool as { groups: Array<Record<string, unknown>> }).groups[0]).toEqual(expect.objectContaining({
    averageUnitCostCny: 0,
    normalCount: 1,
    rateLimitedCount: 0,
    errorCount: 0,
  }));
  expect(result.health).toMatchObject({ normalCount: 1, rateLimitedCount: 0, errorCount: 0, probeStarted: false });
});

test("current rate-limited and error accounts converge expected output to their actual output", async () => {
  const reads = {
    query: async () => ({
      rows: [
        {
          row_kind: "group", scope: "pool", plan_type: "k12", account_count: 3,
          matched_cost_account_count: 3, missing_cost_account_count: 0, present_account_count: 3,
          orphaned_account_count: 0, account_ids: [401, 402, 403], missing_cost_account_ids: [],
          usage_account_count: 3, acquisition_cost_cny: 6.6, request_count: 3, token_count: 30,
          api_amount_usd: 8.5, unavailable_api_amount_usd: 7.5,
          normal_count: 1, rate_limited_count: 1, error_count: 1,
          first_used_at: null, last_used_at: null,
        },
        {
          row_kind: "health", account_count: 3, normal_count: 1, rate_limited_count: 1, error_count: 1,
          active_count: 3, schedulable_count: 1, active_rate_limit_count: 1,
          active_overload_count: 0, active_temp_unschedulable_count: 0,
        },
      ],
      queueDurationMs: 1, queryDurationMs: 1, totalDurationMs: 1,
      queryStartedAt: "2026-07-30T00:00:00.000Z", queryCompletedAt: "2026-07-30T00:00:00.001Z",
      deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const result = await collectOAuthPoolEconomics(
    testConfig,
    reads,
    {
      costs: [
        { accountId: 401, costCny: 2.2, planType: "k12", batchIds: [] },
        { accountId: 402, costCny: 2.2, planType: "k12", batchIds: [] },
        { accountId: 403, costCny: 2.2, planType: "k12", batchIds: [] },
      ],
      refunds: [],
      ledger: {},
    },
  );
  const pool = result.pool as { groups: Array<Record<string, unknown>>; total: Record<string, unknown> };
  expect(pool.groups[0]).toEqual(expect.objectContaining({
    unavailableApiAmountUsd: 7.5,
    configuredExpectedApiAmountUsd: 60,
    invalidatedExpectedApiAmountUsd: 32.5,
    expectedApiAmountUsd: 27.5,
    remainingExpectedApiAmountUsd: 19,
    expectedCnyPerApiUsd: 0.24,
    expectedOutputBasis: "status-adjusted",
    idealApiAmountUsd: 27.5,
  }));
  expect(pool.total).toEqual(expect.objectContaining({
    configuredExpectedApiAmountUsd: 60,
    invalidatedExpectedApiAmountUsd: 32.5,
    expectedApiAmountUsd: 27.5,
    expectedCnyPerApiUsd: 0.24,
    expectedOutputBasis: "status-adjusted",
  }));
});

test("publishes a known pool unit cost with a missing-cost warning", async () => {
  const reads = {
    query: async () => ({
      rows: [
        { row_kind: "group", scope: "pool", plan_type: "team", account_count: 2, matched_cost_account_count: 1, missing_cost_account_count: 1, present_account_count: 2, orphaned_account_count: 0, account_ids: [256, 257], missing_cost_account_ids: [257], usage_account_count: 2, acquisition_cost_cny: 20, request_count: 2, token_count: 30, api_amount_usd: 100, first_used_at: null, last_used_at: null },
        { row_kind: "health", account_count: 2, normal_count: 2, rate_limited_count: 0, error_count: 0, active_count: 2, schedulable_count: 2, active_rate_limit_count: 0, active_overload_count: 0, active_temp_unschedulable_count: 0 },
      ],
      queueDurationMs: 1, queryDurationMs: 1, totalDurationMs: 1,
      queryStartedAt: "2026-07-30T00:00:00.000Z", queryCompletedAt: "2026-07-30T00:00:00.001Z",
      deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const result = await collectOAuthPoolEconomics(
    testConfig,
    reads,
    { costs: [{ accountId: 256, costCny: 20, planType: "team", batchIds: [] }], refunds: [], ledger: {} },
  );
  expect((result.pool as Record<string, any>).total).toEqual(expect.objectContaining({
    cnyPerApiUsd: 0.2,
    idealApiAmountUsd: 280,
    remainingIdealApiAmountUsd: 180,
    idealCnyPerApiUsd: 0.071429,
    missingCostAccountIds: [257],
    complete: false,
  }));
  expect(result.warnings).toEqual([expect.objectContaining({ code: "missing_acquisition_cost", accountIds: [257], missingData: "acquisition_cost_cny" })]);
});

test("unknown account plan keeps actual economics and warns instead of inventing ideal output", async () => {
  const reads = {
    query: async () => ({
      rows: [{
        row_kind: "group", scope: "pool", plan_type: "enterprise", account_count: 1,
        matched_cost_account_count: 1, missing_cost_account_count: 0, present_account_count: 1,
        orphaned_account_count: 0, account_ids: [300], missing_cost_account_ids: [], usage_account_count: 1,
        acquisition_cost_cny: 2, request_count: 1, token_count: 10, api_amount_usd: 1,
        first_used_at: null, last_used_at: null,
      },
      {
        row_kind: "health", account_count: 1, normal_count: 1, rate_limited_count: 0, error_count: 0,
        active_count: 1, schedulable_count: 1, active_rate_limit_count: 0, active_overload_count: 0,
        active_temp_unschedulable_count: 0,
      }],
      queueDurationMs: 1, queryDurationMs: 1, totalDurationMs: 1,
      queryStartedAt: "2026-07-30T00:00:00.000Z", queryCompletedAt: "2026-07-30T00:00:00.001Z",
      deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const result = await collectOAuthPoolEconomics(
    testConfig,
    reads,
    { costs: [{ accountId: 300, costCny: 2, planType: null, batchIds: [] }], refunds: [], ledger: {} },
  );
  expect((result.pool as Record<string, any>).total).toEqual(expect.objectContaining({
    cnyPerApiUsd: 2,
    idealApiAmountUsd: null,
    idealCnyPerApiUsd: null,
    complete: false,
  }));
  expect(result.warnings).toEqual([expect.objectContaining({
    code: "missing_ideal_api_output",
    planTypes: ["enterprise"],
    missingData: "ideal_api_usd_per_account",
  })]);
});

test("remaining ideal output is zero when actual output exceeds the ideal target", async () => {
  const reads = {
    query: async () => ({
      rows: [
        {
          row_kind: "group", scope: "pool", plan_type: "k12", account_count: 1,
          matched_cost_account_count: 1, missing_cost_account_count: 0, present_account_count: 1,
          orphaned_account_count: 0, account_ids: [301], missing_cost_account_ids: [], usage_account_count: 1,
          acquisition_cost_cny: 2, request_count: 1, token_count: 10, api_amount_usd: 25,
          first_used_at: null, last_used_at: null, normal_count: 1, rate_limited_count: 0, error_count: 0,
        },
        {
          row_kind: "health", account_count: 1, normal_count: 1, rate_limited_count: 0, error_count: 0,
          active_count: 1, schedulable_count: 1, active_rate_limit_count: 0, active_overload_count: 0,
          active_temp_unschedulable_count: 0,
        },
      ],
      queueDurationMs: 1, queryDurationMs: 1, totalDurationMs: 1,
      queryStartedAt: "2026-07-30T00:00:00.000Z", queryCompletedAt: "2026-07-30T00:00:00.001Z",
      deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const result = await collectOAuthPoolEconomics(
    testConfig,
    reads,
    { costs: [{ accountId: 301, costCny: 2, planType: "k12", batchIds: [] }], refunds: [], ledger: {} },
  );
  expect((result.pool as Record<string, any>).groups[0]).toEqual(expect.objectContaining({
    apiAmountUsd: 25,
    idealApiAmountUsd: 20,
    remainingIdealApiAmountUsd: 0,
  }));
  expect((result.pool as Record<string, any>).total).toEqual(expect.objectContaining({
    remainingIdealApiAmountUsd: 0,
  }));
});

test("OAuth economics SQL selects a parameterized pool and optional account type", () => {
  expect(oauthEconomicsSql).toContain("a.deleted_at IS NULL");
  expect(oauthEconomicsSql).toContain("LOWER(a.platform) = $4::text");
  expect(oauthEconomicsSql).toContain("LOWER(a.type) = $5::text");
  expect(oauthEconomicsSql).toContain("NULLIF($6::text, '')");
  expect(oauthEconomicsSql).toContain("NULLIF($7::numeric, -1)");
  expect(oauthEconomicsSql).toContain("excluded_accounts");
  expect(oauthEconomicsSql).toContain("$3::text");
  expect(oauthEconomicsSql).toContain("FROM usage_logs usage");
  expect(oauthEconomicsSql).toContain("rate_limit_reset_at");
  expect(oauthEconomicsSql).toContain("schedulable");
  expect(oauthEconomicsSql).toContain("NOW()");
  expect(oauthEconomicsSql).toContain("COUNT(*) FILTER (WHERE current_account.state_bucket = 'normal')");
  expect(oauthEconomicsSql).toContain("unavailable_api_amount_usd");
  expect(oauthEconomicsSql).toContain("current_account.state_bucket IN ('rate_limited', 'error')");
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
    testConfig,
    reads,
    { costs: [], refunds: [], excludedAccountIds: [15, 15], ledger: {} },
  );
  expect(parameters?.[2]).toBe("15");
  expect(result.exclusions).toEqual({ accountIds: [15], count: 1 });
});

test("refund amount cannot exceed the declared batch cost", async () => {
  const reads = { query: async () => { throw new Error("query must not start"); } } as unknown as Sub2ApiReadClient;
  await expect(collectOAuthPoolEconomics(
    testConfig,
    reads,
    {
      costs: [{ accountId: 101, costCny: 3.3, planType: "k12", batchIds: ["batch-a"] }],
      refunds: normalizeOAuthRefunds([{ id: "refund-a", kind: "procurement-refund", amountCny: 3.31, accountIds: [101], batchId: "batch-a", planType: "k12" }]),
      ledger: {},
    },
  )).rejects.toThrow("超过对应批次采购成本");
});
