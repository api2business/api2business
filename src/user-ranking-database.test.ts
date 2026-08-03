import { expect, test } from "bun:test";
import { collectUserRanking, userRankingQuery } from "./user-ranking-database";

test("loads usage, balance and today's recharge through one queued query", async () => {
  let request: Record<string, unknown> | null = null;
  const reads = {
    query: async (input: Record<string, unknown>) => {
      request = input;
      return { rows: [], queueDurationMs: 0, queryDurationMs: 1, totalDurationMs: 1,
        queryStartedAt: "2026-08-02T00:00:00Z", queryCompletedAt: "2026-08-02T00:00:01Z",
        deduplicated: false, cached: false };
    },
    status: () => ({}),
  };
  await collectUserRanking(reads as never, "2026-08-01T16:00:00Z", "2026-08-02T16:00:00Z", "2026-08-01T16:00:00Z", 100);
  expect(request?.kind).toBe("users.daily-ranking");
  expect(request?.parameters).toHaveLength(4);
  expect(userRankingQuery).toContain("u.balance");
  expect(userRankingQuery).toContain("SUM(o.pay_amount)");
  expect(userRankingQuery).toContain("LOWER(COALESCE(u.role, '')) <> 'admin'");
});
