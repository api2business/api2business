import { expect, test } from "bun:test";
import {
  alipayRevenueQuery,
  collectAlipayRevenue,
  parseAlipayRevenueWindow,
} from "./alipay-revenue-database";
import type { AppConfig } from "./config";
import type { Sub2ApiReadClient, Sub2ApiReadRequest } from "./sub2api-read-executor";

test("parses day and month windows in the owning timezone", () => {
  const day = parseAlipayRevenueWindow({ day: "2026-07-29" }, "Asia/Shanghai");
  expect(day.startUtc).toBe("2026-07-28T16:00:00.000Z");
  expect(day.endUtc).toBe("2026-07-29T16:00:00.000Z");
  const period = parseAlipayRevenueWindow({ period: "2026-07" }, "Asia/Shanghai");
  expect(period.startUtc).toBe("2026-06-30T16:00:00.000Z");
  expect(period.endUtc).toBe("2026-07-31T16:00:00.000Z");
  expect(() => parseAlipayRevenueWindow({ day: "2026-07-29", period: "2026-07" }, "Asia/Shanghai"))
    .toThrow("exactly one");
});

test("aggregates completed Alipay revenue through one queued query", async () => {
  let parameters: unknown[] = [];
  const reads = {
    query: async (input: Sub2ApiReadRequest) => {
      parameters = input.parameters;
      return {
        rows: [{ completed_orders: 3, revenue_cny: "240.50", first_paid_at: new Date("2026-07-29T01:00:00Z"), last_paid_at: new Date("2026-07-29T02:00:00Z") }],
        queueDurationMs: 1, queryDurationMs: 2, totalDurationMs: 3,
        queryStartedAt: "2026-07-29T00:00:00Z", queryCompletedAt: "2026-07-29T00:00:01Z",
        deduplicated: false, cached: false,
      };
    },
  } as unknown as Sub2ApiReadClient;
  const result = await collectAlipayRevenue(
    { monitor: { timezone: "Asia/Shanghai" }, operations: { accountImportLedgerPath: "/tmp/apistate-test-missing-import-costs.jsonl" } } as AppConfig,
    reads,
    { day: "2026-07-29" },
  );
  expect(result.completedOrders).toBe(3);
  expect(result.revenueCny).toBe(240.5);
  expect(result.databaseQueries).toBe(1);
  expect(result.accountImportCosts).toEqual({ currency: "CNY", entryCount: 0, totalCostCny: 0 });
  expect(parameters).toEqual(["2026-07-28T16:00:00.000Z", "2026-07-29T16:00:00.000Z"]);
});

test("matches upstream payment semantics without projecting order identity", () => {
  expect(alipayRevenueQuery).toContain("o.status = 'COMPLETED'");
  expect(alipayRevenueQuery).toContain("o.provider_key = 'alipay'");
  expect(alipayRevenueQuery).toContain("o.payment_type = 'alipay'");
  expect(alipayRevenueQuery).toContain("COALESCE(o.paid_at, o.completed_at, o.created_at)");
  expect(alipayRevenueQuery).toContain("LOWER(COALESCE(u.role, '')) <> 'admin'");
  expect(alipayRevenueQuery).not.toContain("user_email");
  expect(alipayRevenueQuery).not.toContain("out_trade_no");
});
