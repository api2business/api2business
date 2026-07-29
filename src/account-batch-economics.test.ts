import { expect, test } from "bun:test";
import {
  accountBatchEconomicsQuery,
  collectAccountBatchEconomics,
  parseAccountEconomicsWindow,
  parseAccountIdSelector,
} from "./account-batch-economics";
import type { AppConfig } from "./config";
import type { Sub2ApiReadClient, Sub2ApiReadRequest } from "./sub2api-read-executor";

test("expands stable account ranges and rejects duplicates", () => {
  expect(parseAccountIdSelector("67-69,71")).toEqual([67, 68, 69, 71]);
  expect(() => parseAccountIdSelector("67,67")).toThrow("unique");
  expect(() => parseAccountIdSelector("70-67")).toThrow("ascending");
});

test("parses a natural day in the owning timezone", () => {
  const window = parseAccountEconomicsWindow({ day: "2026-07-29" }, "Asia/Shanghai");
  expect(window.startUtc).toStartWith("2026-07-28T16:00:00");
  expect(window.endUtc).toStartWith("2026-07-29T16:00:00");
  expect(() => parseAccountEconomicsWindow({ day: "2026-07-29", start: "2026-07-29T00:00:00" }, "Asia/Shanghai"))
    .toThrow("cannot be combined");
});

test("aggregates one complete batch and calculates CNY per API USD", async () => {
  let parameters: unknown[] = [];
  const reads = {
    query: async (input: Sub2ApiReadRequest) => {
      parameters = input.parameters;
      return {
        rows: [{
          selected_account_count: 3,
          matched_account_count: 3,
          usage_account_count: 2,
          missing_account_ids: [],
          request_count: 12,
          token_count: 3400,
          api_amount_usd: "100",
          first_used_at: new Date("2026-07-29T01:00:00Z"),
          last_used_at: new Date("2026-07-29T02:00:00Z"),
        }],
        queueDurationMs: 1,
        queryDurationMs: 2,
        totalDurationMs: 3,
        queryStartedAt: "2026-07-29T00:00:00Z",
        queryCompletedAt: "2026-07-29T00:00:01Z",
        deduplicated: false,
        cached: false,
      };
    },
  } as unknown as Sub2ApiReadClient;
  const config = { monitor: { timezone: "Asia/Shanghai" } } as AppConfig;
  const result = await collectAccountBatchEconomics(config, reads, {
    accountIds: [69, 67, 68], costCny: 49.11, day: "2026-07-29",
  });
  expect(result.complete).toBe(true);
  expect(result.accountIds).toEqual([67, 68, 69]);
  expect(result.cnyPerApiUsd).toBe(0.4911);
  expect(result.databaseQueries).toBe(1);
  expect(parameters).toEqual(["67,68,69", "2026-07-28T16:00:00.000Z", "2026-07-29T16:00:00.000Z"]);
});

test("does not publish a unit cost for missing accounts or zero usage", async () => {
  const reads = {
    query: async () => ({
      rows: [{ selected_account_count: 2, matched_account_count: 1, usage_account_count: 0, missing_account_ids: [88], request_count: 0, token_count: 0, api_amount_usd: 0 }],
      queueDurationMs: 0, queryDurationMs: 0, totalDurationMs: 0,
      queryStartedAt: "2026-07-29T00:00:00Z", queryCompletedAt: "2026-07-29T00:00:00Z",
      deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const result = await collectAccountBatchEconomics(
    { monitor: { timezone: "Asia/Shanghai" } } as AppConfig,
    reads,
    { accountIds: [87, 88], costCny: 20, day: "2026-07-29" },
  );
  expect(result.complete).toBe(false);
  expect(result.cnyPerApiUsd).toBeNull();
  expect(result.incompleteReasons).toEqual(["missing_accounts", "zero_api_amount"]);
});

test("uses one bounded aggregate without projecting account secrets", () => {
  expect(accountBatchEconomicsQuery).toContain("usage.created_at >= $2::timestamptz");
  expect(accountBatchEconomicsQuery).toContain("usage.created_at < $3::timestamptz");
  expect(accountBatchEconomicsQuery).toContain("SUM(usage.actual_cost)");
  expect(accountBatchEconomicsQuery).not.toContain("credentials");
  expect(accountBatchEconomicsQuery).not.toContain("account.name");
});
