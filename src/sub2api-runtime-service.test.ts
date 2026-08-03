import { expect, test } from "bun:test";
import { Sub2ApiRuntimeService } from "./sub2api-runtime-service";
import type { Sub2ApiClient } from "./sub2api-client";

test("imports Grok OAuth through native batch create and preserves Grok fields", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = { mutate: async (_method: string, path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    return { success: 1, failed: 0, results: [{ id: 451, success: true }] };
  } } as unknown as Sub2ApiClient;
  const runtime = new Sub2ApiRuntimeService(client);
  const output = await runtime.importAccounts({
    operationKey: "grok-import-test",
    importTimeoutMs: 120000,
    content: JSON.stringify({ accounts: [{ name: "grok-a", platform: "grok", type: "oauth", credentials: { account_id: "grok-a", access_token: "token" } }] }),
    priority: 1, capacity: 16, groupIds: [6], proxyId: 14, proxyCandidateIds: [14], perAccountProxy: false,
  });
  expect(calls[0]?.path).toBe("/admin/accounts/batch");
  expect(calls[0]?.body).toEqual({ accounts: [expect.objectContaining({ platform: "grok", type: "oauth", priority: 1, concurrency: 16, proxy_id: 14, group_ids: [6] })] });
  expect(output).toEqual(expect.objectContaining({ ok: true, result: expect.objectContaining({ createdIds: [451], failed: 0 }) }));
});

test("keeps OpenAI OAuth on the codex-session import endpoint", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown>; timeoutMs?: number }> = [];
  const client = { mutate: async (_method: string, path: string, body: Record<string, unknown>, _key?: string, timeoutMs?: number) => {
    calls.push({ path, body, timeoutMs });
    return { failed: 0, items: [{ index: 1, account_id: 452, action: "created" }] };
  } } as unknown as Sub2ApiClient;
  const runtime = new Sub2ApiRuntimeService(client);
  await runtime.importAccounts({
    operationKey: "openai-import-test",
    importTimeoutMs: 120000,
    content: JSON.stringify({ accounts: [{ name: "codex-a", platform: "openai", type: "oauth", credentials: { access_token: "token" } }] }),
    priority: 1, capacity: 16, groupIds: [2, 3], proxyId: 14, proxyCandidateIds: [14], perAccountProxy: false,
  });
  expect(calls).toEqual([expect.objectContaining({
    path: "/admin/accounts/import/codex-session",
    body: expect.objectContaining({ update_existing: true }),
    timeoutMs: 120000,
  })]);
});

test("corrects account plan types with one native bulk credentials merge", async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const client = { mutate: async (method: string, path: string, body: Record<string, unknown>) => {
    calls.push({ method, path, body });
    return { success: 2, failed: 0, success_ids: [400, 401] };
  } } as unknown as Sub2ApiClient;
  const runtime = new Sub2ApiRuntimeService(client);
  const output = await runtime.correctAccountPlanTypes([401, 400, 401], "k12");
  expect(calls).toEqual([{ method: "POST", path: "/admin/accounts/bulk-update", body: {
    account_ids: [400, 401], credentials: { plan_type: "k12" },
  } }]);
  expect(output).toEqual(expect.objectContaining({ accountIds: [400, 401], planType: "k12" }));
});
