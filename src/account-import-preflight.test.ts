import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { accountImportPreflight } from "./account-import-preflight";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

test("skips only uniquely matched accounts whose runtime settings are aligned", async () => {
  const reads = {
    query: async () => ({
      rows: [
        { row_kind: "account", id: 41, user_id: "user-aligned", access_token_sha256: tokenHash("token-a"), priority: 1, concurrency: 5, proxy_id: 141, proxy_name: "proxy-141", plan_type: "k12", group_ids: [2, 3] },
        { row_kind: "account", id: 42, user_id: "user-stale", access_token_sha256: tokenHash("token-b"), priority: 1, concurrency: 10, proxy_id: 142, proxy_name: "proxy-142", plan_type: "free", group_ids: [2, 3] },
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
    platform: "openai", priority: 1, capacity: 5, groupIds: [2, 3], sourceProxyId: 3, planType: "k12",
  }, reads);
  expect(plan.skipped).toEqual([{ index: 1, accountId: 41 }]);
  expect(plan.sourceIndexes).toEqual([2]);
  expect(plan.pendingExisting).toEqual([{ index: 2, accountId: 42 }]);
  expect(plan.planTypeCorrections).toEqual([]);
  expect(plan.proxyCandidateIds).toEqual([141, 142]);
  expect(plan.proxyCandidateIds).toContain(plan.initialProxyId);
  expect((JSON.parse(plan.content) as { accounts: unknown[] }).accounts).toHaveLength(1);
  expect((JSON.parse(plan.content) as { accounts: Array<{ credentials: { plan_type: string } }> }).accounts[0]?.credentials.plan_type).toBe("k12");
});

test("skips an aligned account bound to any existing proxy in the matching pool", async () => {
  const reads = {
    query: async () => ({
      rows: [
        { row_kind: "account", id: 79, user_id: "user-repair", access_token_sha256: tokenHash("token"), priority: 1, concurrency: 5, proxy_id: 3, proxy_name: "source", plan_type: "plus", group_ids: [2, 3] },
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
    platform: "openai", priority: 1, capacity: 5, groupIds: [2, 3], sourceProxyId: 3, planType: "plus",
  }, reads);
  expect(plan.skipped).toEqual([{ index: 1, accountId: 79 }]);
  expect(plan.sourceIndexes).toEqual([]);
  expect(plan.planTypeCorrections).toEqual([]);
  expect((JSON.parse(plan.content) as { accounts: unknown[] }).accounts).toHaveLength(0);
});

test("plans a direct type correction without reimporting an otherwise aligned OAuth account", async () => {
  const reads = {
    query: async () => ({
      rows: [
        { row_kind: "account", id: 400, user_id: "user-type-only", access_token_sha256: tokenHash("token"), priority: 1, concurrency: 16, proxy_id: 44, proxy_name: "proxy-44", plan_type: "free", group_ids: [2, 3] },
        { row_kind: "proxy", id: 44 },
      ],
      queueDurationMs: 0, queryDurationMs: 0, totalDurationMs: 0,
      queryStartedAt: "2026-01-01T00:00:00.000Z", queryCompletedAt: "2026-01-01T00:00:00.000Z",
      deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const plan = await accountImportPreflight(JSON.stringify({ accounts: [
    { credentials: { chatgpt_user_id: "user-type-only", access_token: "token" } },
  ], proxies: [] }), {
    platform: "openai", priority: 1, capacity: 16, groupIds: [2, 3], sourceProxyId: 3, planType: "k12",
  }, reads);
  expect(plan.sourceIndexes).toEqual([]);
  expect(plan.pendingExisting).toEqual([]);
  expect(plan.skipped).toEqual([{ index: 1, accountId: 400 }]);
  expect(plan.planTypeCorrections).toEqual([{ index: 1, accountId: 400 }]);
  expect((JSON.parse(plan.content) as { accounts: unknown[] }).accounts).toEqual([]);
});

test("reimports the same OAuth user when the access token fingerprint changed", async () => {
  const reads = {
    query: async () => ({
      rows: [
        { row_kind: "account", id: 127, user_id: "user-recycled", access_token_sha256: tokenHash("old-token"), priority: 1, concurrency: 16, proxy_id: 3, proxy_name: "source", plan_type: "k12", group_ids: [2, 3] },
        { row_kind: "proxy", id: 3 },
      ],
      queueDurationMs: 0, queryDurationMs: 0, totalDurationMs: 0,
      queryStartedAt: "2026-01-01T00:00:00.000Z", queryCompletedAt: "2026-01-01T00:00:00.000Z",
      deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const content = JSON.stringify({ accounts: [
    { credentials: { chatgpt_user_id: "user-recycled", access_token: "new-token" } },
  ], proxies: [] });
  const plan = await accountImportPreflight(content, {
    platform: "openai", priority: 1, capacity: 16, groupIds: [2, 3], sourceProxyId: 3, planType: "k12",
  }, reads);
  expect(plan.skipped).toEqual([]);
  expect(plan.sourceIndexes).toEqual([1]);
  expect(plan.pendingExisting).toEqual([{ index: 1, accountId: 127 }]);
  expect((JSON.parse(plan.content) as { accounts: unknown[] }).accounts).toHaveLength(1);
});

test("selects the same initial proxy for the same import identity regardless of candidate order", async () => {
  const reads = (proxyIds: number[]) => ({
    query: async () => ({
      rows: proxyIds.map((id) => ({ row_kind: "proxy", id })),
      queueDurationMs: 0, queryDurationMs: 0, totalDurationMs: 0,
      queryStartedAt: "2026-01-01T00:00:00.000Z", queryCompletedAt: "2026-01-01T00:00:00.000Z",
      deduplicated: false, cached: false,
    }),
  }) as unknown as Sub2ApiReadClient;
  const content = JSON.stringify({ accounts: [
    { credentials: { chatgpt_user_id: "user-new", access_token: "token" } },
  ], proxies: [] });
  const settings = { platform: "openai" as const, priority: 1, capacity: 16, groupIds: [3, 2], sourceProxyId: 3, planType: "plus" as const };
  const first = await accountImportPreflight(content, settings, reads([31, 3, 19]));
  const repeated = await accountImportPreflight(content, { ...settings, groupIds: [2, 3] }, reads([19, 31, 3]));
  expect(first.proxyCandidateIds).toEqual([3, 19, 31]);
  expect(repeated.proxyCandidateIds).toEqual(first.proxyCandidateIds);
  expect(repeated.initialProxyId).toBe(first.initialProxyId);
  expect(first.proxyCandidateIds).toContain(first.initialProxyId);
  expect((JSON.parse(first.content) as { accounts: Array<{ credentials: { plan_type: string } }> }).accounts[0]?.credentials.plan_type).toBe("plus");
});

test("accepts Free as the selected import plan type and overlays credentials", async () => {
  const reads = {
    query: async () => ({
      rows: [{ row_kind: "proxy", id: 3 }],
      queueDurationMs: 0, queryDurationMs: 0, totalDurationMs: 0,
      queryStartedAt: "2026-01-01T00:00:00.000Z", queryCompletedAt: "2026-01-01T00:00:00.000Z",
      deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const plan = await accountImportPreflight(JSON.stringify({ accounts: [
    { credentials: { chatgpt_user_id: "user-free", access_token: "token-free" } },
  ], proxies: [] }), {
    platform: "openai", priority: 1, capacity: 16, groupIds: [2, 3], sourceProxyId: 3, planType: "free",
  }, reads);
  expect((JSON.parse(plan.content) as { accounts: Array<{ credentials: { plan_type: string } }> }).accounts[0]?.credentials.plan_type).toBe("free");
});

test("accepts Team as the selected import plan type and overlays credentials", async () => {
  const reads = {
    query: async () => ({
      rows: [{ row_kind: "proxy", id: 3 }],
      queueDurationMs: 0, queryDurationMs: 0, totalDurationMs: 0,
      queryStartedAt: "2026-01-01T00:00:00.000Z", queryCompletedAt: "2026-01-01T00:00:00.000Z",
      deduplicated: false, cached: false,
    }),
  } as unknown as Sub2ApiReadClient;
  const content = JSON.stringify({ accounts: [
    { credentials: { chatgpt_user_id: "user-team", access_token: "token-team", plan_type: "plus" } },
  ], proxies: [] });
  const plan = await accountImportPreflight(content, {
    platform: "openai", priority: 1, capacity: 16, groupIds: [2, 3], sourceProxyId: 3, planType: "team",
  }, reads);
  expect((JSON.parse(plan.content) as { accounts: Array<{ credentials: { plan_type: string } }> }).accounts[0]?.credentials.plan_type).toBe("team");
});

test("preflights Grok accounts in the Grok platform and overlays Free", async () => {
  let parameters: unknown[] = [];
  const reads = {
    query: async (request: { parameters: unknown[] }) => {
      parameters = request.parameters;
      return {
        rows: [{ row_kind: "proxy", id: 3 }],
        queueDurationMs: 0, queryDurationMs: 0, totalDurationMs: 0,
        queryStartedAt: "2026-01-01T00:00:00.000Z", queryCompletedAt: "2026-01-01T00:00:00.000Z",
        deduplicated: false, cached: false,
      };
    },
  } as unknown as Sub2ApiReadClient;
  const content = JSON.stringify({ accounts: [
    { platform: "grok", type: "oauth", credentials: { account_id: "grok-a", access_token: "token-grok" } },
  ], proxies: [] });
  const plan = await accountImportPreflight(content, {
    platform: "grok", priority: 1, capacity: 16, groupIds: [6], sourceProxyId: 3, planType: "free",
  }, reads);
  expect(parameters[3]).toBe("grok");
  expect((JSON.parse(plan.content) as { accounts: Array<{ platform: string; credentials: { plan_type: string } }> }).accounts[0])
    .toEqual(expect.objectContaining({ platform: "grok", credentials: expect.objectContaining({ plan_type: "free" }) }));
});
