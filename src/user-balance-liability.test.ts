import { expect, test } from "bun:test";
import type { Sub2ApiReadClient, Sub2ApiReadRequest } from "./sub2api-read-executor";
import {
  collectUserBalanceLiability,
  userBalanceLiabilityQuery,
} from "./user-balance-liability";

test("aggregates current non-admin balances through one uncached queued query", async () => {
  let request: Sub2ApiReadRequest | null = null;
  const reads = {
    query: async (input: Sub2ApiReadRequest) => {
      request = input;
      return {
        rows: [{
          non_admin_users: 5,
          positive_balance_users: 2,
          zero_balance_users: 1,
          negative_balance_users: 2,
          signed_balance_usd: "120.125",
          redeemable_balance_usd: "150.125",
          negative_balance_usd: "-30",
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

  const result = await collectUserBalanceLiability(reads);
  expect(result).toMatchObject({
    nonAdminUserCount: 5,
    positiveBalanceUserCount: 2,
    zeroBalanceUserCount: 1,
    negativeBalanceUserCount: 2,
    signedBalanceUsd: 120.125,
    redeemableBalanceUsd: 150.125,
    negativeBalanceUsd: -30,
    databaseQueries: 1,
  });
  const captured = request as Sub2ApiReadRequest | null;
  expect(captured?.cacheMode).toBe("bypass-cache");
  expect(captured?.parameters).toEqual([]);
});

test("excludes administrators and deleted users without exposing identity", () => {
  expect(userBalanceLiabilityQuery).toContain("u.deleted_at IS NULL");
  expect(userBalanceLiabilityQuery).toContain("LOWER(COALESCE(u.role, '')) <> 'admin'");
  expect(userBalanceLiabilityQuery).toContain("SUM(GREATEST(u.balance, 0))");
  expect(userBalanceLiabilityQuery).toContain("SUM(LEAST(u.balance, 0))");
  expect(userBalanceLiabilityQuery).toContain("u.email NOT LIKE 'api2business-probe-%@sub2api.platform-infra.local'");
  expect(userBalanceLiabilityQuery).toContain("u.email <> 'monitor-user@sub2api.platform-infra.local'");
  expect(userBalanceLiabilityQuery).not.toContain("u.email,");
  expect(userBalanceLiabilityQuery).not.toContain("password_hash");
});
