import { expect, test } from "bun:test";
import { loadConfig } from "./config";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import { findAccountId, formatRate, formatUpstreamName, normalizeBaseUrl, parseUpstreamName, UpstreamManagementService, validateCapacity, validateGroupIds, validatePriority, validateRate, validateSuffix } from "./upstream-management";

test("upstream names preserve historical six-decimal rates", () => {
  expect(normalizeBaseUrl("https://api.example.com/")).toBe("https://api.example.com");
  expect(formatRate(0.045)).toBe("0.045");
  expect(formatUpstreamName("https://api.example.com/", "plus", 0.045)).toBe("https://api.example.com plus 0.045");
  expect(parseUpstreamName("https://api.example.com plus 0.045", "https://api.example.com")).toEqual({
    suffix: "plus",
    rateCnyPerApiUsd: 0.045,
  });
});

test("upstream inputs reject unsafe URLs, suffixes, and rates", () => {
  expect(() => normalizeBaseUrl("http://api.example.com")).toThrow("HTTPS URL");
  expect(() => normalizeBaseUrl("https://user:pass@api.example.com")).toThrow("HTTPS URL");
  expect(() => validateSuffix("plus space")).toThrow("后缀");
  expect(() => validateRate(0.0000001)).toThrow("6 位小数");
});

test("runtime mutation results can expose the account ID inside items", () => {
  expect(findAccountId({
    ok: true,
    operation: "create",
    items: [{ accountId: 123, actual: { accountId: 456 } }],
  })).toBe(123);
});

test("runtime mutation results accept account-shaped and nested data IDs", () => {
  expect(findAccountId({ ok: true, account: { id: 307 } })).toBe(307);
  expect(findAccountId({ ok: true, data: { account: { account_id: "308" } } })).toBe(308);
});

test("runtime upstream settings validate priority, capacity, and pool selection", () => {
  expect(validatePriority(1)).toBe(1);
  expect(validateCapacity(16)).toBe(16);
  expect(validateGroupIds([3, 2, 3])).toEqual([2, 3]);
  expect(() => validatePriority(0)).toThrow("初始优先级");
  expect(() => validateCapacity(0)).toThrow("并发容量");
  expect(() => validateGroupIds([])).toThrow("号池");
});

test("failover template uses the Sub2API native error_code schema", async () => {
  const config = await Bun.file(new URL("../config/sub2rank.yaml", import.meta.url)).text();
  expect(config).toContain("errorCode: 502");
  expect(config).toContain("errorCode: 524");
  expect(config).toContain("input exceeds the context window of this model");
  expect(config).not.toMatch(/errorCode: 404\n/u);
  expect(config).not.toContain("statusCode:");
});

test("usage target discovery uses one queued database read", async () => {
  const originalFetch = globalThis.fetch;
  let databaseQueries = 0;
  globalThis.fetch = (async () => new Response(JSON.stringify({ mode: "unrestricted", usage: { total_tokens: 5 } }))) as unknown as typeof fetch;
  try {
    const config = loadConfig("config/sub2rank.yaml");
    const reads = {
      async query() {
        databaseQueries += 1;
        return {
          rows: [{ id: 8, name: "example", base_url: "https://api.example.com/v1", api_key: "sk-secret" }],
          queueDurationMs: 1,
          queryDurationMs: 2,
          totalDurationMs: 3,
          queryStartedAt: new Date().toISOString(),
          queryCompletedAt: new Date().toISOString(),
          deduplicated: false,
          cached: false,
        };
      },
      status() { throw new Error("not used"); },
    } as unknown as Sub2ApiReadClient;
    const service = new UpstreamManagementService(config, reads);
    const result = await service.usage([8]);
    expect(databaseQueries).toBe(1);
    expect(result.databaseQueries).toBe(1);
    expect(result.targetCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rolling upstream output excludes OAuth usage", async () => {
  const source = await Bun.file(new URL("./upstream-management.ts", import.meta.url)).text();
  expect(source).toContain("LOWER(usage_account.type) = 'apikey'");
  expect(source).toContain("usage_account.id = usage.account_id");
});

test("template application verifies persisted runtime fields through the queued reader", async () => {
  const source = await Bun.file(new URL("./upstream-management.ts", import.meta.url)).text();
  expect(source).toContain("upstream-template-verify");
  expect(source).toContain("runtime-template-readback-mismatch");
  expect(source).toContain("verifiedCount");
});

test("upstream creation applies and verifies the failover template before success", async () => {
  const source = await Bun.file(new URL("./upstream-management.ts", import.meta.url)).text();
  const createBody = source.slice(source.indexOf("  async create(input:"), source.indexOf("  async update(id:"));
  expect(createBody).toContain("await this.applyTemplate([resolvedAccountId])");
  expect(createBody).toContain('operation: "template", partial: true');
  expect(createBody).toContain("template: { applied: true, verified: true }");
});

test("recharge recovery covers every API-key account in the normalized wallet", async () => {
  const source = await Bun.file(new URL("./upstream-management.ts", import.meta.url)).text();
  const rechargeBody = source.slice(source.indexOf("  async recharge(id:"), source.lastIndexOf("\n}"));
  expect(rechargeBody).toContain("await this.walletAccounts(account.baseUrl)");
  expect(rechargeBody).toContain("recoveredAccountIds.push(candidate.id)");
  expect(rechargeBody).toContain("walletAccountIds: walletAccounts.map");
});
