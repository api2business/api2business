import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config";
import { ProbeIsolationService } from "./probe-isolation";

type Row = Record<string, unknown>;

interface FakeState {
  groups: Row[];
  users: Row[];
  keys: Row[];
  account: Row;
  groupCreates: Row[];
  keyCreates: Row[];
  accountUpdates: Row[];
  requestTimeouts: Array<{ path: string; timeoutMs: number }>;
}

class FakeClient {
  constructor(private readonly state: FakeState) {}

  fork() { return new FakeClient(this.state); }

  async request<T>(path: string, _init?: unknown, _authenticate?: boolean, timeoutMs?: number): Promise<T> {
    if (timeoutMs !== undefined) this.state.requestTimeouts.push({ path, timeoutMs });
    if (path.startsWith("/admin/groups?")) return { items: this.state.groups, total: this.state.groups.length, page: 1, page_size: 100, pages: 1 } as T;
    if (/^\/admin\/groups\/\d+$/u.test(path)) return this.state.groups.find((item) => Number(item.id) === Number(path.split("/").at(-1))) as T;
    if (path.startsWith("/admin/users?")) return { items: this.state.users, total: this.state.users.length, page: 1, page_size: 100, pages: 1 } as T;
    if (/^\/admin\/users\/\d+$/u.test(path)) return this.state.users.find((item) => Number(item.id) === Number(path.split("/").at(-1))) as T;
    if (path.startsWith("/keys?")) return { items: this.state.keys, total: this.state.keys.length, page: 1, page_size: 100, pages: 1 } as T;
    throw new Error(`unexpected request ${path}`);
  }

  async mutate<T>(method: string, path: string, body: unknown, _key?: string, timeoutMs?: number): Promise<T> {
    if (timeoutMs !== undefined) this.state.requestTimeouts.push({ path: `${method} ${path}`, timeoutMs });
    const payload = body as Row;
    if (method === "POST" && path === "/admin/groups") {
      this.state.groupCreates.push(payload);
      const group = { id: 51, status: "active", ...payload };
      this.state.groups.push(group);
      return group as T;
    }
    if (method === "PUT" && path === "/admin/groups/51") {
      Object.assign(this.state.groups[0]!, payload);
      return this.state.groups[0] as T;
    }
    if (method === "POST" && path === "/admin/users") {
      const user = { id: 61, status: "active", ...payload };
      this.state.users.push(user);
      return user as T;
    }
    if (method === "PUT" && path === "/admin/users/61") {
      Object.assign(this.state.users[0]!, payload);
      return this.state.users[0] as T;
    }
    if (method === "POST" && path === "/keys") {
      this.state.keyCreates.push(payload);
      const key = { id: 71, key: payload.custom_key, status: "active", ...payload };
      this.state.keys.push(key);
      return key as T;
    }
    if (method === "PUT" && path === "/keys/71") {
      Object.assign(this.state.keys[0]!, payload);
      return this.state.keys[0] as T;
    }
    throw new Error(`unexpected mutation ${method} ${path}`);
  }

  async getAccount(_accountId?: number, timeoutMs?: number) {
    if (timeoutMs !== undefined) this.state.requestTimeouts.push({ path: "get-account", timeoutMs });
    return this.state.account;
  }

  async listGroupAccounts(groupId: number, _platform?: string, timeoutMs?: number) {
    if (timeoutMs !== undefined) this.state.requestTimeouts.push({ path: "list-group-accounts", timeoutMs });
    return Array.isArray(this.state.account.group_ids) && this.state.account.group_ids.includes(groupId)
      ? [{ id: this.state.account.id }]
      : [];
  }
}

function fixture() {
  const rootDirectory = mkdtempSync(join(tmpdir(), "apistate-probe-isolation-"));
  const state: FakeState = {
    groups: [],
    users: [],
    keys: [],
    account: { id: 42, platform: "openai", type: "apikey", group_ids: [2, 3] },
    groupCreates: [],
    keyCreates: [],
    accountUpdates: [],
    requestTimeouts: [],
  };
  const config = {
    rootDirectory,
    sub2api: {
      idleProbe: {
        roundTimeoutSeconds: 50,
        isolation: {
          enabled: true,
          gatewayBaseUrl: "https://api.example.com/v1",
          groupNamePrefix: "apistate-probe-",
          groupRateMultiplier: 0.0001,
          userBalance: 0.01,
          secretFile: ".state/idle-probe/probe-keys.json",
        },
      },
    },
    operations: {
      upstreamManagement: { mutationTimeoutMs: 120000 },
    },
  } as AppConfig;
  const client = new FakeClient(state);
  const runtime = {
    updateAccount: async (_accountId: number, patch: Row) => {
      state.accountUpdates.push(patch);
      Object.assign(state.account, { group_ids: patch.group_ids });
    },
  };
  return { rootDirectory, state, service: new ProbeIsolationService(config, client as never, runtime as never) };
}

test("probe isolation creates one private internal-ID group and redacts every secret", async () => {
  const { rootDirectory, state, service } = fixture();
  const result = await service.ensure(42);

  expect(result).toEqual({ accountId: 42, groupId: 51, keyCreated: true });
  expect(JSON.stringify(result)).not.toMatch(/apiKey|email|password|sk-/u);
  expect(state.groupCreates).toEqual([expect.objectContaining({
    name: "apistate-probe-42",
    is_exclusive: true,
    rate_multiplier: 0.0001,
  })]);
  expect(String(state.groupCreates[0]?.name)).not.toContain("hwpod.com");
  expect(state.keyCreates).toEqual([expect.objectContaining({ name: "apistate-probe", group_id: 51 })]);
  expect(state.accountUpdates).toEqual([expect.objectContaining({ group_ids: [2, 3, 51] })]);
  expect(state.requestTimeouts.length).toBeGreaterThan(0);
  expect(state.requestTimeouts.every(({ timeoutMs }) => timeoutMs > 100000 && timeoutMs <= 120000)).toBe(true);

  const secretPath = join(rootDirectory, ".state/idle-probe/probe-keys.json");
  expect(statSync(secretPath).mode & 0o777).toBe(0o600);
  const secret = JSON.parse(readFileSync(secretPath, "utf8")) as Row;
  expect(JSON.stringify(secret)).toContain("sk-apistate-probe-");
});

test("concurrent ensure calls are idempotent and keep the target as the only group member", async () => {
  const { state, service } = fixture();
  const results = await Promise.all([service.ensure(42), service.ensure(42)]);

  expect(results[0]).toMatchObject({ accountId: 42, groupId: 51 });
  expect(results[1]).toMatchObject({ accountId: 42, groupId: 51, keyCreated: false });
  expect(state.groupCreates).toHaveLength(1);
  expect(state.keyCreates).toHaveLength(1);
  expect(state.accountUpdates).toHaveLength(1);
});

test("standalone provisioning resets the bounded budget between credential and account-binding stages", async () => {
  const { state, service } = fixture();
  const fake = service as unknown as { admin: { mutate: (...args: unknown[]) => Promise<unknown> } };
  const mutate = fake.admin.mutate.bind(fake.admin);
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  fake.admin.mutate = async (...args) => {
    const result = await mutate(...args);
    if (args[1] === "/keys") now += 110_000;
    return result;
  };
  try {
    await service.ensure(42);
  } finally {
    Date.now = originalNow;
  }

  const accountRead = state.requestTimeouts.find(({ path }) => path === "get-account");
  expect(accountRead?.timeoutMs).toBe(120000);
});

test("probe isolation rejects a private group shared with another upstream account", async () => {
  const { service } = fixture();
  const fake = service as unknown as { admin: { listGroupAccounts: () => Promise<Row[]> } };
  fake.admin.listGroupAccounts = async () => [{ id: 42 }, { id: 99 }];
  await expect(service.ensure(42)).rejects.toThrow("存在其他账号成员");
});

test("probe uses the ordinary gateway Responses path instead of the admin account-test API", async () => {
  const { service } = fixture();
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody = "";
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    requestUrl = String(input);
    requestBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ id: "resp_probe", output: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const result = await service.probe(42, "gpt-5.5", 1000);
    expect(result).toMatchObject({ accountId: 42, groupId: 51, classification: "alive", ordinaryLogRecorded: true });
    expect(requestUrl).toBe("https://api.example.com/v1/responses");
    expect(requestUrl).not.toContain("/admin/accounts/");
    expect(JSON.parse(requestBody)).toMatchObject({ model: "gpt-5.5", stream: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probe reports a gateway timeout without claiming an ordinary log", async () => {
  const { service } = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  }) as unknown as typeof fetch;
  try {
    const result = await service.probe(42, "gpt-5.5", 1000);
    expect(result).toMatchObject({
      accountId: 42,
      groupId: 51,
      classification: "error",
      httpStatus: null,
      ordinaryLogRecorded: false,
      errorMarker: "request-timeout",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probe isolation persists generated credentials before a remote credential-stage failure", async () => {
  const { rootDirectory, service } = fixture();
  const fake = service as unknown as { admin: { request: (path: string) => Promise<unknown> } };
  const request = fake.admin.request.bind(fake.admin);
  fake.admin.request = async (path) => {
    if (path.startsWith("/admin/users?")) throw new DOMException("The operation timed out.", "TimeoutError");
    return await request(path);
  };

  await expect(service.ensure(42)).rejects.toThrow("探活隔离专用凭据阶段失败");
  const secretPath = join(rootDirectory, ".state/idle-probe/probe-keys.json");
  expect(statSync(secretPath).mode & 0o777).toBe(0o600);
  const secret = JSON.parse(readFileSync(secretPath, "utf8")) as { records: Record<string, Row> };
  expect(secret.records["42"]).toMatchObject({ accountId: 42, groupId: 51, userId: 0 });
  expect(String(secret.records["42"]?.apiKey)).toStartWith("sk-apistate-probe-");
  expect(service.get(42)).toBeNull();
});

test("probe isolation reuses the persisted key when the API masks existing key plaintext", async () => {
  const { state, service } = fixture();
  await service.ensure(42);
  delete state.keys[0]?.key;

  expect(await service.ensure(42)).toMatchObject({ accountId: 42, groupId: 51, keyCreated: false });
  expect(state.keyCreates).toHaveLength(1);
});

test("probe isolation resumes at account binding after credentials were persisted", async () => {
  const { rootDirectory, state, service } = fixture();
  const fake = service as unknown as { admin: { getAccount: () => Promise<Row> } };
  const getAccount = fake.admin.getAccount.bind(fake.admin);
  fake.admin.getAccount = async () => { throw new DOMException("The operation timed out.", "TimeoutError"); };

  await expect(service.ensure(42)).rejects.toThrow("探活隔离账号绑定阶段失败");
  const secretPath = join(rootDirectory, ".state/idle-probe/probe-keys.json");
  const partial = JSON.parse(readFileSync(secretPath, "utf8")) as { records: Record<string, Row> };
  expect(partial.records["42"]).toMatchObject({ userId: 61, ready: false });
  expect(service.get(42)).toBeNull();

  fake.admin.getAccount = getAccount;
  expect(await service.ensure(42)).toMatchObject({ accountId: 42, groupId: 51, keyCreated: false });
  expect(state.keyCreates).toHaveLength(1);
});
