import { expect, test } from "bun:test";
import { loadConfig } from "./config";
import { initializeUpstreams, verifyOnboardingProbes, finishUpstreamCreation, type OnboardingResult } from "./upstream-onboarding";
import type { Sub2ApiReadRequest, Sub2ApiReadResult } from "./sub2api-read-executor";
import type { ProbeIsolationScope } from "./probe-isolation";

type Row = Record<string, unknown>;

function fixture(mismatched = false) {
  const config = loadConfig("config/api2business.example.yaml");
  const platforms = ["openai", "anthropic", "grok"] as const;
  const patches: Array<{ ids: number[]; patch: Row; platform?: string }> = [];
  const bindings: Array<{ accountId: number; scope?: ProbeIsolationScope }> = [];
  const reads = { async query<T extends Row>(request: Sub2ApiReadRequest): Promise<Sub2ApiReadResult<T>> {
    expect(request.cacheMode).toBe("bypass-cache");
    const id = Number(request.parameters[0]);
    const index = id - 10;
    const rows = request.kind.endsWith("targets")
      ? platforms.map((platform, i) => ({ id: String(10 + i), platform, group_ids: [String(100 + i)] }))
      : [{ platform: platforms[index], temp_enabled: true,
        temp_rules: config.operations.upstreamManagement.failoverRulesByPlatform[platforms[index]!],
        responses_mode: index === 0 && !mismatched ? "force_responses" : null,
        group_ids: [String(100 + index), String(200 + index)],
        is_exclusive: true, probe_group_status: "active", member_count: "1" }];
    return { rows: rows as unknown as T[], cached: false, deduplicated: false,
      queueDurationMs: 0, queryDurationMs: 0, totalDurationMs: 0, queryStartedAt: "", queryCompletedAt: "" };
  } };
  const runtime = { async configureApiKeyAccounts(ids: number[], patch: Row, _timeout?: number, platform?: string) {
    patches.push({ ids, patch, platform });
    return { ok: true };
  } };
  const isolation = { async ensure(accountId: number, scope?: ProbeIsolationScope) {
    bindings.push({ accountId, scope });
    return { accountId, groupId: accountId + 190, keyCreated: false };
  } };
  return { config, reads, runtime, isolation, patches, bindings };
}

test("initialization preserves business groups, verifies templates and forces Responses only for Codex", async () => {
  const f = fixture();
  const result = await initializeUpstreams(f.config, f.reads, f.runtime, f.isolation, [10, 11, 12]);
  expect(result).toMatchObject({ ok: true, targetCount: 3, verifiedCount: 3, failedCount: 0 });
  expect(f.patches[0]).toMatchObject({ ids: [10], platform: "openai", patch: { extra: { openai_responses_mode: "force_responses" } } });
  for (const patch of f.patches.slice(1)) expect(patch.patch).not.toHaveProperty("extra");
  for (const patch of f.patches) {
    expect(patch.patch).not.toHaveProperty("group_ids");
    expect(patch.patch).not.toHaveProperty("proxy_id");
    expect(patch.patch.credentials).not.toHaveProperty("api_key");
    expect(patch.patch.credentials).not.toHaveProperty("pool_mode");
  }
  expect(f.bindings.map((binding) => binding.scope?.bindingGroupIds)).toEqual([[], [], []]);
  expect(result.accounts[0]).toMatchObject({ responsesVerified: true, probeReady: true });
});

test("Responses readback mismatch is partial even when native update was accepted", async () => {
  const f = fixture(true);
  const result = await initializeUpstreams(f.config, f.reads, f.runtime, f.isolation, [10, 11, 12]);
  expect(result).toMatchObject({ ok: false, verifiedCount: 2, failedCount: 1 });
  expect(result.accounts[0]).toMatchObject({ ok: false, responsesVerified: false, error: "上游初始化写后回读不一致" });
});

test("one account failing initialization does not hide the other platform results", async () => {
  const f = fixture();
  const result = await initializeUpstreams(f.config, f.reads, f.runtime, {
    ensure: async (id, scope) => {
      if (id === 10) throw new Error("probe binding timeout");
      return f.isolation.ensure(id, scope);
    },
  }, [10, 11, 12]);
  expect(result).toMatchObject({ ok: false, verifiedCount: 2, failedCount: 1 });
  expect(result.accounts[0]?.accountId).toBe(10);
});

test("in-flight skip is visible and never counts as verified probe", async () => {
  const initialized: OnboardingResult = { ok: true, operation: "initialize", targetCount: 1, verifiedCount: 1,
    failedCount: 0, accounts: [{ accountId: 10, platform: "openai", scope: "codex", automaticProbeEnabled: true,
      ok: true, templateVerified: true, responsesMode: "force_responses", responsesVerified: true, probeReady: true, groupId: 200 }] };
  const result = await verifyOnboardingProbes(initialized, {
    runIdleProbe: async () => ({ ok: true, skipped: true, reason: "in-flight" }),
  }, "operation");
  expect(result).toMatchObject({ ok: false, status: "partial", probeVerifiedCount: 0,
    probes: [{ verified: false, skipped: true, reason: "in-flight" }] });
  const created = await finishUpstreamCreation({ ok: true, account: { id: 10 }, skipDetection: true },
    async () => initialized, { runIdleProbe: async () => ({ attempted: 1, succeeded: 1, failed: 0 }) }, "retry");
  expect(created).toMatchObject({ ok: true, status: "ready", onboarding: { probeVerifiedCount: 1 } });
});
