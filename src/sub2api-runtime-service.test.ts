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
  expect(calls[0]?.body).toEqual({ accounts: [expect.objectContaining({ platform: "grok", type: "oauth", priority: 1, concurrency: 16, load_factor: 1, proxy_id: 14, group_ids: [6] })] });
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
    priority: 1, capacity: 16, rateMultiplier: 1000, groupIds: [2, 3], proxyId: 14, proxyCandidateIds: [14], perAccountProxy: false,
  });
  expect(calls).toEqual([expect.objectContaining({
    path: "/admin/accounts/import/codex-session",
    body: expect.objectContaining({ update_existing: true, load_factor: 1000 }),
    timeoutMs: 120000,
  })]);
});

test("uses native batch create when OpenAI preflight proves every account is new", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown>; timeoutMs?: number }> = [];
  const client = { mutate: async (_method: string, path: string, body: Record<string, unknown>, _key?: string, timeoutMs?: number) => {
    calls.push({ path, body, timeoutMs });
    return { success: 1, failed: 0, results: [{ id: 453, success: true }] };
  } } as unknown as Sub2ApiClient;
  const runtime = new Sub2ApiRuntimeService(client);
  const output = await runtime.importAccounts({
    operationKey: "openai-create-only-test",
    importTimeoutMs: 120000,
    content: JSON.stringify({ accounts: [{
      name: "codex-new", platform: "openai", type: "oauth",
      credentials: { access_token: "token", refresh_token: "refresh", chatgpt_user_id: "user-new" },
    }] }),
    priority: 1, capacity: 16, groupIds: [2, 3], proxyId: 14,
    proxyCandidateIds: [14], perAccountProxy: false, createOnly: true,
  });
  expect(calls).toEqual([expect.objectContaining({
    path: "/admin/accounts/batch",
    body: { accounts: [expect.objectContaining({
      platform: "openai", type: "oauth", priority: 1, concurrency: 16,
      load_factor: 1, proxy_id: 14, group_ids: [2, 3], confirm_mixed_channel_risk: true,
      extra: expect.objectContaining({ access_token_sha256: expect.any(String), import_source: "api2business-batch" }),
    })] },
    timeoutMs: 120000,
  })]);
  expect(output).toEqual(expect.objectContaining({
    ok: true,
    result: expect.objectContaining({ createdIds: [453], createdCount: 1, failed: 0 }),
  }));
});

test("keeps access-token-only OpenAI imports on the session normalization path", async () => {
  const calls: string[] = [];
  const client = { mutate: async (_method: string, path: string) => {
    calls.push(path);
    return { failed: 0, items: [{ index: 1, account_id: 454, action: "created" }] };
  } } as unknown as Sub2ApiClient;
  const runtime = new Sub2ApiRuntimeService(client);
  await runtime.importAccounts({
    operationKey: "openai-access-only-test",
    importTimeoutMs: 120000,
    content: JSON.stringify({ accounts: [{
      name: "codex-access-only", platform: "openai", type: "oauth",
      credentials: { access_token: "token", chatgpt_user_id: "user-access-only" },
    }] }),
    priority: 1, capacity: 16, groupIds: [2, 3], proxyId: 14,
    proxyCandidateIds: [14], perAccountProxy: false, createOnly: true,
  });
  expect(calls).toEqual(["/admin/accounts/import/codex-session"]);
});

test("imports API-key accounts with load factor without changing billing multiplier", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = { mutate: async (_method: string, path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    return { account_created: 1, account_failed: 0 };
  } } as unknown as Sub2ApiClient;
  const runtime = new Sub2ApiRuntimeService(client);
  await runtime.importAccounts({
    operationKey: "api-key-import-test",
    importTimeoutMs: 120000,
    content: JSON.stringify({ accounts: [{ name: "api-key-a", platform: "openai", type: "apikey", credentials: { api_key: "redacted" } }] }),
    priority: 1, capacity: 16, rateMultiplier: 1000, groupIds: [3], proxyId: 14, proxyCandidateIds: [14], perAccountProxy: false,
  });
  expect(calls).toEqual([{ path: "/admin/accounts/data", body: expect.objectContaining({
    data: { accounts: [expect.objectContaining({ load_factor: 1000, credentials: expect.objectContaining({ api_key: "redacted" }) })], proxies: [] },
  }) }]);
  expect((calls[0]?.body.data as { accounts: Array<Record<string, unknown>> }).accounts[0]).not.toHaveProperty("rate_multiplier");
});

test("API-key creation uses the native batch endpoint and YAML-owned mutation timeout", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown>; timeoutMs?: number }> = [];
  const client = { mutate: async (_method: string, path: string, body: Record<string, unknown>, _key?: string, timeoutMs?: number) => {
    calls.push({ path, body, timeoutMs });
    return { id: 455 };
  } } as unknown as Sub2ApiClient;
  const runtime = new Sub2ApiRuntimeService(client);
  await runtime.createApiKeyAccount({ credentials: { api_key: "redacted" } }, "create-key", 120000);
  expect(calls).toEqual([{ path: "/admin/accounts/batch", body: {
    accounts: [expect.objectContaining({
      confirm_mixed_channel_risk: true,
      credentials: expect.objectContaining({ api_key: "redacted", temp_unschedulable_enabled: true }),
    })],
  }, timeoutMs: 120000 }]);
});

test("bulk API-key configuration combines runtime settings and failover template", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = { mutate: async (_method: string, path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    return { success: 2, failed: 0, success_ids: [486, 487] };
  } } as unknown as Sub2ApiClient;
  const runtime = new Sub2ApiRuntimeService(client, [{ error_code: 503, keywords: ["overloaded"], duration_minutes: 3 }]);
  await runtime.configureApiKeyAccounts([487, 486], {
    priority: 1,
    concurrency: 16,
    proxy_id: 3,
    group_ids: [2, 3],
  }, 120000);
  expect(calls).toEqual([{ path: "/admin/accounts/bulk-update", body: expect.objectContaining({
    account_ids: [486, 487],
    priority: 1,
    concurrency: 16,
    proxy_id: 3,
    group_ids: [2, 3],
    confirm_mixed_channel_risk: true,
    credentials: expect.objectContaining({ temp_unschedulable_enabled: true }),
  }) }]);
});

test("bulk API-key template uses the YAML-owned mutation timeout", async () => {
  const calls: Array<{ path: string; timeoutMs?: number }> = [];
  const client = { mutate: async (_method: string, path: string, _body: unknown, _key?: string, timeoutMs?: number) => {
    calls.push({ path, timeoutMs });
    return { success: 2, failed: 0 };
  } } as unknown as Sub2ApiClient;
  const runtime = new Sub2ApiRuntimeService(client);
  await runtime.applyApiKeyFailoverTemplates([478, 479], 120000);
  expect(calls).toEqual([{ path: "/admin/accounts/bulk-update", timeoutMs: 120000 }]);
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

test("recovers a planned account batch with one native bulk request", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const runtime = new Sub2ApiRuntimeService({
    mutate: async (method: string, path: string, body: unknown) => {
      calls.push({ method, path, body });
      return { success: 3, failed: 0 };
    },
  } as never);

  expect(await runtime.recoverAccounts([9, 7, 8])).toMatchObject({ accountIds: [7, 8, 9], recovered: 3 });
  expect(calls).toEqual([{
    method: "POST",
    path: "/admin/accounts/bulk-update",
    body: { account_ids: [7, 8, 9], status: "active", schedulable: true },
  }]);
});

test("deletes accounts with one native batch request", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const runtime = new Sub2ApiRuntimeService({
    mutate: async (method: string, path: string, body: unknown, _key: string | undefined, timeoutMs: number | undefined) => {
      calls.push({ method, path, body, timeoutMs });
      return { total: 3, success: 3, failed: 0, success_ids: [9, 7, 8], failed_ids: [] };
    },
  } as never);

  expect(await runtime.deleteAccounts([9, 7, 8, 9], 60000)).toEqual({ deleted: 3, accountIds: [7, 8, 9] });
  expect(calls).toEqual([{
    method: "POST",
    path: "/admin/accounts/batch-delete",
    body: { account_ids: [7, 8, 9] },
    timeoutMs: 60000,
  }]);
});

test("updates accounts with the same priority in one native bulk request", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown>; timeoutMs?: number }> = [];
  const client = { mutate: async (_method: string, path: string, body: Record<string, unknown>, _key?: string, timeoutMs?: number) => {
    calls.push({ path, body, timeoutMs });
    return { success: 2, failed: 0, success_ids: [402, 403], failed_ids: [] };
  } } as unknown as Sub2ApiClient;
  const runtime = new Sub2ApiRuntimeService(client);
  const output = await runtime.updatePriorities({ "403": 120, "402": 120 }, 30000);
  expect(calls).toEqual([{ path: "/admin/accounts/bulk-update", body: {
    account_ids: [402, 403], priority: 120,
  }, timeoutMs: 30000 }]);
  expect(output).toEqual({
    updated: 2,
    bulkUpdateCount: 1,
    bulkUpdates: [{ priority: 120, accountIds: [402, 403], updated: 2 }],
  });
});

test("updates distinct priorities concurrently inside the caller batch", async () => {
  let active = 0;
  let maximumActive = 0;
  const client = { mutate: async (_method: string, _path: string, body: Record<string, unknown>) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Bun.sleep(5);
    active -= 1;
    return { success: 1, failed: 0, success_ids: body.account_ids, failed_ids: [] };
  } } as unknown as Sub2ApiClient;
  const runtime = new Sub2ApiRuntimeService(client);
  const output = await runtime.updatePriorities({ "404": 110, "405": 120, "406": 130 });
  expect(maximumActive).toBe(3);
  expect(output).toEqual(expect.objectContaining({ updated: 3, bulkUpdateCount: 3 }));
});

test("rejects a partial native bulk priority update", async () => {
  const client = { mutate: async () => ({
    success: 1,
    failed: 1,
    success_ids: [407],
    failed_ids: [408],
  }) } as unknown as Sub2ApiClient;
  const runtime = new Sub2ApiRuntimeService(client);
  expect(runtime.updatePriorities({ "407": 140, "408": 140 })).rejects.toThrow(
    "Sub2API bulk priority update failed for accounts 408",
  );
});

test("waits for every concurrent bulk write before reporting one failure", async () => {
  let slowWriteFinished = false;
  const client = { mutate: async (_method: string, _path: string, body: Record<string, unknown>) => {
    const accountIds = body.account_ids as number[];
    if (accountIds[0] === 409) {
      return { success: 0, failed: 1, success_ids: [], failed_ids: [409] };
    }
    await Bun.sleep(5);
    slowWriteFinished = true;
    return { success: 1, failed: 0, success_ids: accountIds, failed_ids: [] };
  } } as unknown as Sub2ApiClient;
  const runtime = new Sub2ApiRuntimeService(client);
  await expect(runtime.updatePriorities({ "409": 150, "410": 160 })).rejects.toThrow(
    "Sub2API bulk priority update failed for accounts 409",
  );
  expect(slowWriteFinished).toBe(true);
});
