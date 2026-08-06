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

test("upstream creation bootstrap rate is YAML-owned", () => {
  const config = loadConfig("config/api2business.example.yaml");
  expect(config.operations.upstreamManagement.createBootstrapRateCnyPerApiUsd).toBe(1);
});

test("upstream create worker probes quota and synchronizes the detected rate", async () => {
  const source = await Bun.file(new URL("./worker.ts", import.meta.url)).text();
  const createBranch = source.slice(
    source.indexOf('if (pending.action === "create")'),
    source.indexOf('else if (pending.action === "update")'),
  );
  expect(createBranch).toContain("await upstreams.usage([accountId])");
  expect(createBranch).toContain("await upstreams.synchronizeDetectedRates");
  expect(createBranch).toContain("await internal.upstreamUsageCache");
  expect(createBranch).toContain("result.detection = detected");
});

test("detected rate synchronization requires queued readback", async () => {
  const source = await Bun.file(new URL("./upstream-management.ts", import.meta.url)).text();
  const synchronization = source.slice(
    source.indexOf("  async synchronizeDetectedRates("),
    source.indexOf("  async applyTemplate("),
  );
  expect(synchronization).toContain("await this.accountQuery(result.accountId)");
  expect(synchronization).toContain("探测费率写入后排队回读不一致");
});

test("upstream identity ignores the temporary rate for the same URL and suffix", async () => {
  const source = await Bun.file(new URL("./upstream-management.ts", import.meta.url)).text();
  const identityQuery = source.slice(
    source.indexOf("  private async accountQueryByIdentity("),
    source.indexOf("  private async walletAccounts("),
  );
  expect(identityQuery).toContain("parseUpstreamName(name, baseUrl)?.suffix");
  expect(identityQuery).toContain("a.name LIKE RTRIM($2::text, '/') || ' ' || $3::text || ' %'");
});

test("fully configured recovered upstreams skip mutation and repeated detection", async () => {
  const management = await Bun.file(new URL("./upstream-management.ts", import.meta.url)).text();
  const worker = await Bun.file(new URL("./worker.ts", import.meta.url)).text();
  expect(management).toContain('idempotentFastPath: true');
  expect(management).toContain('skipDetection: true');
  expect(worker).toContain("result.skipDetection !== true");
});

test("successful account imports submit an independent OAuth runtime sample", async () => {
  const source = await Bun.file(new URL("./worker.ts", import.meta.url)).text();
  const importBranch = source.slice(
    source.indexOf('if (command.kind === "account.import")'),
    source.indexOf('if (command.kind === "account.lifecycle.detect")'),
  );
  expect(source).toContain('{ kind: "oauth.runtime.sample" }');
  expect(importBranch).toContain('job.state === "succeeded"');
  expect(importBranch).toContain("temporalGateway.submit");
  expect(importBranch).toContain("postImportOAuthSample");
  expect(importBranch).not.toContain("await operations.sampleOAuthRuntime()");
  expect(source).toContain('if (command.kind === "upstream.quota.sample")');
  expect(source).toContain("const oauth = await operations.sampleOAuthRuntime()");
  expect(source).not.toMatch(/await temporal\./u);
});

test("failover template uses the Sub2API native error_code schema", async () => {
  const config = await Bun.file(new URL("../config/api2business.example.yaml", import.meta.url)).text();
  expect(config).toContain("errorCode: 502");
  expect(config).toContain("errorCode: 524");
  expect(config).not.toContain("input must be a list");
  expect(config).not.toContain("input exceeds the context window of this model");
  expect(config).not.toContain("openai_error");
  expect(config).not.toContain("model_not_found");
  expect(config).not.toMatch(/errorCode: 404\n/u);
  expect(config).not.toContain("statusCode:");
  expect(config).not.toMatch(/errorCode: 503[\s\S]*model_not_found/u);
});

test("usage target discovery uses one queued database read", async () => {
  const originalFetch = globalThis.fetch;
  let databaseQueries = 0;
  globalThis.fetch = (async () => new Response(JSON.stringify({ mode: "unrestricted", usage: { total_tokens: 5 } }))) as unknown as typeof fetch;
  try {
    const config = loadConfig("config/api2business.example.yaml");
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
  expect(source).toMatch(/LOWER\(a\.type\)\s*=\s*'apikey'/u);
  expect(source).toContain("SUM(usage.actual_cost)");
});

test("template application verifies persisted runtime fields through the queued reader", async () => {
  const source = await Bun.file(new URL("./upstream-management.ts", import.meta.url)).text();
  expect(source).toContain("upstream-template-verify");
  expect(source).toContain("runtime-template-readback-mismatch");
  expect(source).toContain("verifiedCount");
});

test("upstream creation keeps the created account successful when post-processing is incomplete", async () => {
  const source = await Bun.file(new URL("./upstream-management.ts", import.meta.url)).text();
  const createBody = source.slice(source.indexOf("  async create(input:"), source.indexOf("  async update(id:"));
  expect(createBody).toContain("await this.runtime.configureApiKeyAccounts(");
  expect(createBody).toContain("await this.probeIsolation.ensure(resolvedAccountId)");
  expect(createBody).toContain("this.probeIsolation.get(resolvedAccountId)");
  expect(createBody).toContain("const postProcess = async () =>");
  expect(createBody).toContain("settings.mutationTimeoutMs");
  expect(createBody).toContain("await postProcess();");
  expect(createBody).toContain("返回账号快照可能早于最终倍率探测回写");
  expect(createBody).not.toContain("上游账号已创建，但 Codex 通用切号模板未通过校验");
});

test("recharge recovery covers every API-key account in the normalized wallet", async () => {
  const source = await Bun.file(new URL("./upstream-management.ts", import.meta.url)).text();
  const rechargeBody = source.slice(source.indexOf("  async recharge(id:"), source.lastIndexOf("\n}"));
  expect(rechargeBody).toContain("await this.walletAccounts(account.baseUrl)");
  expect(rechargeBody).toContain("recoveredAccountIds.push(...recoveryTargets.map((candidate) => candidate.id))");
  expect(rechargeBody).toContain("walletAccountIds: walletAccounts.map");
  expect(rechargeBody).toContain("await this.runtime!.recoverAccounts(");
  expect(rechargeBody).not.toContain("await this.runtime!.recoverAccount(candidate.id)");
});

test("wallet recovery query filters the normalized wallet in SQL", async () => {
  const source = await Bun.file(new URL("./upstream-management.ts", import.meta.url)).text();
  const wallet = source.slice(source.indexOf("  private async walletAccounts("), source.indexOf("  private async resolveCreatedAccount("));
  expect(wallet).toContain("RTRIM(a.credentials->>'base_url', '/') = RTRIM($1::text, '/')");
  expect(wallet).toContain("parameters: [normalizeUpstreamWallet(baseUrl)]");
});

test("new upstream runtime settings and failover template use one bulk update", async () => {
  const source = await Bun.file(new URL("./upstream-management.ts", import.meta.url)).text();
  const postProcess = source.slice(source.indexOf("    const postProcess = async () =>"), source.indexOf("    await postProcess();"));
  expect(postProcess).toContain("await this.runtime.configureApiKeyAccounts(");
  expect(postProcess).toContain("temp_unschedulable_rules");
  expect(postProcess).not.toContain("applyApiKeyFailoverTemplates");
});
