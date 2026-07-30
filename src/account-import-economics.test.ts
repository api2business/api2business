import { expect, test } from "bun:test";
import {
  accountImportEconomicsQuery,
  collectAccountImportEconomics,
  normalizeExternalAccountCosts,
} from "./account-import-economics";
import type { AppConfig } from "./config";
import type { Sub2ApiReadClient, Sub2ApiReadRequest } from "./sub2api-read-executor";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAccountImportCosts } from "./account-import-cost-ledger";

test("validates external acquisition costs", () => {
  expect(normalizeExternalAccountCosts([{ accountId: 98, costCny: 18.8 }]))
    .toEqual([{ accountId: 98, costCny: 18.8 }]);
  expect(() => normalizeExternalAccountCosts([{ accountId: 98, costCny: 18.8 }, { accountId: 98, costCny: 18.8 }]))
    .toThrow("unique");
});

test("aggregates plan types and total economics in one queued query", async () => {
  const requests: Sub2ApiReadRequest[] = [];
  const reads = {
    query: async (input: Sub2ApiReadRequest) => {
      requests.push(input);
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
  expect(requests[0]?.kind).toBe("accounts.import-economics");
  expect(requests[0]?.parameters).toHaveLength(4);
});

test("reads only plan type from account credentials and never projects secret fields", () => {
  expect(accountImportEconomicsQuery).toContain("credentials->>'plan_type'");
  expect(accountImportEconomicsQuery).toContain("string_to_array($1::text, ',')::bigint[]");
  expect(accountImportEconomicsQuery).toContain("JOIN account_scope scope ON scope.account_id = usage.account_id");
  expect(accountImportEconomicsQuery).not.toContain("access_token");
  expect(accountImportEconomicsQuery).not.toContain("refresh_token");
  expect(accountImportEconomicsQuery).not.toContain("account.name");
});

test("keeps historical usage for accounts that were deleted after import", async () => {
  const reads = {
    query: async () => ({
      rows: [{
        plan_type: "missing", account_count: 2, matched_account_count: 0, usage_account_count: 2,
        missing_account_ids: [104, 105], request_count: 378, token_count: 1970000,
        acquisition_cost_cny: 6.6, api_amount_usd: 39.8498441,
      }],
      queueDurationMs: 0, queryDurationMs: 1, totalDurationMs: 1,
      queryStartedAt: "", queryCompletedAt: "", deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const result = await collectAccountImportEconomics(
    { monitor: { timezone: "Asia/Shanghai" }, operations: { accountImportLedgerPath: "/tmp/missing-history.jsonl" } } as AppConfig,
    reads,
    { day: "2026-07-30", externalCosts: [{ accountId: 104, costCny: 3.3 }, { accountId: 105, costCny: 3.3 }] },
  );
  expect(result.total).toEqual(expect.objectContaining({ apiAmountUsd: 39.8498441, cnyPerApiUsd: 0.165622 }));
  expect(result.groups).toEqual([expect.objectContaining({ planType: "missing", apiAmountUsd: 39.8498441, missingAccountIds: [104, 105] })]);
});

test("projects stable import batches independently of deleted account matches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "apistate-batch-economics-"));
  const path = join(directory, "costs.jsonl");
  try {
    recordAccountImportCosts({ path, fingerprint: "batch-abc12345", accountIds: [108, 109], unitCostCny: 3.3, planType: "k12", occurredOn: "2026-07-30" });
    const reads = { query: async () => ({ rows: [], queueDurationMs: 0, queryDurationMs: 0, totalDurationMs: 0, queryStartedAt: "", queryCompletedAt: "", deduplicated: false, cached: false }) } as unknown as Sub2ApiReadClient;
    const result = await collectAccountImportEconomics({ monitor: { timezone: "Asia/Shanghai" }, operations: { accountImportLedgerPath: path } } as AppConfig, reads, { day: "2026-07-30" });
    expect(result.batches).toEqual([expect.objectContaining({ batchId: "account-import-batch-batch-abc12345", planType: "k12", accountIds: [108, 109], grossAcquisitionCostCny: 6.6 })]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
