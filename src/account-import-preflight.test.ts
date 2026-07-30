import { expect, test } from "bun:test";
import { accountImportPreflight } from "./account-import-preflight";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

test("skips only uniquely matched accounts whose runtime settings are aligned", async () => {
  const reads = {
    query: async () => ({
      rows: [
        { row_kind: "account", id: 41, user_id: "user-aligned", access_token_sha256: "", priority: 1, concurrency: 5, proxy_id: 141, proxy_name: "proxy-141", group_ids: [2, 3] },
        { row_kind: "account", id: 42, user_id: "user-stale", access_token_sha256: "", priority: 1, concurrency: 10, proxy_id: 142, proxy_name: "proxy-142", group_ids: [2, 3] },
        { row_kind: "proxy", id: 141 },
        { row_kind: "proxy", id: 142 },
      ],
      queueDurationMs: 0, queryDurationMs: 0, totalDurationMs: 0,
      queryStartedAt: "2026-01-01T00:00:00.000Z", queryCompletedAt: "2026-01-01T00:00:00.000Z",
      deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const content = JSON.stringify({ accounts: [
    { credentials: { chatgpt_user_id: "user-aligned", access_token: "token-a" } },
    { credentials: { chatgpt_user_id: "user-stale", access_token: "token-b" } },
  ], proxies: [] });
  const plan = await accountImportPreflight(content, {
    priority: 1, capacity: 5, groupIds: [2, 3], sourceProxyId: 3,
  }, reads);
  expect(plan.skipped).toEqual([{ index: 1, accountId: 41 }]);
  expect(plan.sourceIndexes).toEqual([2]);
  expect(plan.proxyCandidateIds).toEqual([141, 142]);
  expect(plan.proxyCandidateIds).toContain(plan.initialProxyId);
  expect((JSON.parse(plan.content) as { accounts: unknown[] }).accounts).toHaveLength(1);
});

test("skips an aligned account bound to any existing proxy in the matching pool", async () => {
  const reads = {
    query: async () => ({
      rows: [
        { row_kind: "account", id: 79, user_id: "user-repair", access_token_sha256: "", priority: 1, concurrency: 5, proxy_id: 3, proxy_name: "source", group_ids: [2, 3] },
        { row_kind: "proxy", id: 3 },
      ],
      queueDurationMs: 0, queryDurationMs: 0, totalDurationMs: 0,
      queryStartedAt: "2026-01-01T00:00:00.000Z", queryCompletedAt: "2026-01-01T00:00:00.000Z",
      deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const content = JSON.stringify({ accounts: [
    { credentials: { chatgpt_user_id: "user-repair", access_token: "token" } },
  ], proxies: [] });
  const plan = await accountImportPreflight(content, {
    priority: 1, capacity: 5, groupIds: [2, 3], sourceProxyId: 3,
  }, reads);
  expect(plan.skipped).toEqual([{ index: 1, accountId: 79 }]);
  expect(plan.sourceIndexes).toEqual([]);
  expect((JSON.parse(plan.content) as { accounts: unknown[] }).accounts).toHaveLength(0);
});
