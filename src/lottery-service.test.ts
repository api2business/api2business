import { expect, test } from "bun:test";
import { LotteryService, rankingDisplayName } from "./lottery-service";
import type { Sub2ApiUser } from "./types";
import { loadConfig } from "./config";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import type { LotteryStore } from "./store";
import type { Sub2ApiClient } from "./sub2api-client";

function user(email: string, username: string): Sub2ApiUser {
  return {
    id: 1,
    email,
    username,
    role: "user",
    status: "active",
    balance: 0,
  };
}

test("user ranking exposes the complete email instead of a masked username", () => {
  expect(rankingDisplayName(user("xiaoyang@test.com", "xi*****@test.com"))).toBe("xiaoyang@test.com");
});

test("user ranking falls back to username only when email is absent", () => {
  expect(rankingDisplayName(user("", "lannmao"))).toBe("lannmao");
  expect(rankingDisplayName(user("", ""))).toBe("匿名用户");
});

test("active user totals and ranking include every eligible user beyond source and display limits", async () => {
  const config = loadConfig("config/api2business.example.yaml");
  config.ranking.sourceLimit = 5;
  config.ranking.displayLimit = 20;
  const eligible = Array.from({ length: 105 }, (_, index) => ({
    user_id: index + 1, username: `user-${index}`, email: `user-${index}@test.com`,
    role: "user", status: "active", balance: 3, actual_cost: 2, requests: 4, tokens: 10, recharge_cny: 1,
  }));
  let queries = 0;
  const reads = { query: async (input: { parameters: unknown[] }) => {
    queries++;
    expect(input.parameters).toHaveLength(3);
    return { rows: [...eligible,
      { ...eligible[0], user_id: 1001, role: "admin", actual_cost: 999 },
      { ...eligible[0], user_id: 1002, status: "disabled", actual_cost: 999 },
      { ...eligible[0], user_id: 1003, username: "example-user", actual_cost: 999 },
    ], queryCompletedAt: "2026-10-18T11:00:00Z", cached: false };
  } };
  const service = new LotteryService(config, {} as LotteryStore, {} as Sub2ApiClient, reads as unknown as Sub2ApiReadClient);
  const result = await service.ranking(new Date("2026-10-18T11:00:00Z"));
  expect(queries).toBe(1);
  expect(result.activeUsers).toBe(105);
  expect(result.pageSize).toBe(20);
  expect(result.rows).toHaveLength(105);
  expect(result.rows.at(-1)?.rank).toBe(105);
  expect(result.totals).toEqual({ actualCost: 210, requests: 420, tokens: 1050, balanceUsd: 315, rechargeCny: 105 });
  expect(result.startDate).toBe("2026-10-18");
});
