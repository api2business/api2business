import { expect, test } from "bun:test";
import {
  accountImportEconomicsQuery,
  collectAccountImportEconomics,
  normalizeExternalAccountCosts,
} from "./account-import-economics";
import type { AppConfig } from "./config";
import type { Sub2ApiReadClient, Sub2ApiReadRequest } from "./sub2api-read-executor";

test("validates external acquisition costs", () => {
  expect(normalizeExternalAccountCosts([{ accountId: 98, costCny: 18.8 }]))
    .toEqual([{ accountId: 98, costCny: 18.8 }]);
  expect(() => normalizeExternalAccountCosts([{ accountId: 98, costCny: 18.8 }, { accountId: 98, costCny: 18.8 }]))
    .toThrow("unique");
});

test("aggregates plan types and total economics in one queued query", async () => {
  let request: Sub2ApiReadRequest | null = null;
  const reads = {
    query: async (input: Sub2ApiReadRequest) => {
      request = input;
      return {
        rows: [
          { plan_type: "k12", account_count: 5, matched_account_count: 5, usage_account_count: 5, missing_account_ids: [], acquisition_cost_cny: 16.4, request_count: 397, token_count: 2977903, api_amount_usd: 32.5941498 },
          { plan_type: "plus", account_count: 1, matched_account_count: 1, usage_account_count: 1, missing_account_ids: [], acquisition_cost_cny: 18.8, request_count: 925, token_count: 6370218, api_amount_usd: 94.8366988 },
        ],
        queueDurationMs: 1, queryDurationMs: 2, totalDurationMs: 3,
        queryStartedAt: "2026-07-30T00:00:00Z", queryCompletedAt: "2026-07-30T00:00:01Z",
        deduplicated: false, cached: false,
      };
    },
  } as unknown as Sub2ApiReadClient;
  const config = {
    monitor: { timezone: "Asia/Shanghai" },
    operations: { accountImportLedgerPath: "/tmp/apistate-import-economics-missing.jsonl" },
  } as AppConfig;
  const result = await collectAccountImportEconomics(config, reads, {
    day: "2026-07-30",
    externalCosts: [
      { accountId: 98, costCny: 18.8 },
      { accountId: 99, costCny: 3.28 }, { accountId: 100, costCny: 3.28 },
      { accountId: 101, costCny: 3.28 }, { accountId: 102, costCny: 3.28 },
      { accountId: 103, costCny: 3.28 },
    ],
  });
  expect(result.complete).toBe(true);
  expect(result.total).toEqual(expect.objectContaining({
    accountCount: 6, acquisitionCostCny: 35.2, apiAmountUsd: 127.4308486,
    cnyPerApiUsd: 0.276228, requestCount: 1322, tokenCount: 9348121,
  }));
  expect(request?.kind).toBe("accounts.import-economics");
  expect(request?.parameters).toHaveLength(3);
});

test("reads only plan type from account credentials and never projects secret fields", () => {
  expect(accountImportEconomicsQuery).toContain("credentials->>'plan_type'");
  expect(accountImportEconomicsQuery).not.toContain("access_token");
  expect(accountImportEconomicsQuery).not.toContain("refresh_token");
  expect(accountImportEconomicsQuery).not.toContain("account.name");
});
