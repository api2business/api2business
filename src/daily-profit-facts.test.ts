import { expect, test } from "bun:test";
import { DateTime } from "luxon";
import { collectDailyProfitFacts, dailyProfitFactsQuery, parseCompletedProfitDay } from "./daily-profit-facts";

test("reconstructs opening and closing positive balances in one uncached query", async () => {
  let captured: Record<string, unknown> | null = null;
  const result = await collectDailyProfitFacts({ monitor: { timezone: "Asia/Shanghai" } } as never, {
    query: async (input: Record<string, unknown>) => {
      captured = input;
      return {
        rows: [{
          opening_users: 3, opening_positive_users: 2, opening_signed_balance: "90", opening_redeemable_balance: "100", opening_negative_balance: "-10",
          closing_users: 4, closing_positive_users: 3, closing_signed_balance: "130", closing_redeemable_balance: "145", closing_negative_balance: "-15",
          usage_events: 8, redeem_events: 2, affiliate_events: 1, promo_events: 0, refund_events: 1, rollback_failed_events: 0,
          completed_orders: 3, revenue_cny: "60",
        }],
        cached: false, deduplicated: false, queueDurationMs: 2, queryDurationMs: 4,
        queryStartedAt: "2026-07-30T00:00:00Z", queryCompletedAt: "2026-07-30T00:00:01Z",
      };
    },
  } as never, "2026-07-29");

  expect(captured).toMatchObject({ kind: "profit.daily-facts", cacheMode: "bypass-cache", priority: "manual" });
  expect(result).toMatchObject({
    mode: "daily-profit-facts-postgresql",
    alipay: { completedOrders: 3, revenueCny: 60 },
    liability: { opening: { redeemableBalanceUsd: 100 }, closing: { redeemableBalanceUsd: 145 }, redeemableChangeUsd: 45 },
    replay: { complete: true, rollbackFailedEvents: 0 },
    databaseQueries: 1,
  });
});

test("rejects a natural day that has not ended", () => {
  expect(() => parseCompletedProfitDay("2026-07-29", "Asia/Shanghai", DateTime.fromISO("2026-07-29T12:00:00+08:00").toMillis()))
    .toThrow("--day must be a completed natural day");
});

test("query replays persisted balance mutations per user before positive aggregation", () => {
  expect(dailyProfitFactsQuery).toContain("u.balance::numeric - COALESCE(e.delta_after_start, 0)");
  expect(dailyProfitFactsQuery).toContain("SUM(GREATEST(opening_balance, 0))");
  expect(dailyProfitFactsQuery).toContain("SUM(GREATEST(closing_balance, 0))");
  expect(dailyProfitFactsQuery).toContain("FROM usage_logs");
  expect(dailyProfitFactsQuery).toContain("COALESCE(billing_type, 0) = 0");
  expect(dailyProfitFactsQuery).toContain("FROM redeem_codes");
  expect(dailyProfitFactsQuery).toContain("FROM user_affiliate_ledger");
  expect(dailyProfitFactsQuery).toContain("FROM promo_code_usages");
  expect(dailyProfitFactsQuery).toContain("REFUND_SUCCESS");
});
