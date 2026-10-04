import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";
import { UpstreamSchedulingV2Service } from "./upstream-scheduling-v2";

function fixture(usageRows = [{
  account_id: 101,
  last_success_at: "2026-10-03T00:01:00.000Z",
  last_success_result: { ok: true, quota: { unit: "USD", remaining: 12.5, limit: 20, used: 7.5, unlimited: false } },
}]) {
  const config = loadConfig("config/api2business.example.yaml");
  const row = {
    accountId: 101,
    accountName: "codex-a",
    platform: "openai",
    accountType: "apikey",
    groupIds: [2, 3],
    groupNames: ["codex"],
    score: 92,
    grade: "A",
    priority: 100,
    currentStatus: "active",
    currentAvailable: true,
    confidence: "high",
    observedAttempts: 120,
    failureRate: 0.01,
    failoverRate: 0,
    ttftP95Ms: 1000,
    scoreComponents: { reliability: 92, latency: 90, failover: 100, weights: { reliability: 48, latency: 37, failover: 10 } },
    usage: { costRateCnyPerApiUsd: 0.2 },
  };
  const claudeRow = {
    ...row,
    accountId: 202,
    accountName: "claude-a",
    platform: "anthropic",
    groupIds: [119],
    groupNames: ["claude"],
    score: 88,
    grade: "B",
  };
  const grokRow = {
    ...row,
    accountId: 303,
    accountName: "grok-a",
    platform: "grok",
    groupIds: [62],
    groupNames: ["【稳定·企业级】Grok"],
    score: 86,
    grade: "B",
  };
  const calls = { dispatch: 0, save: 0 };
  const dispatcher = {
    dispatch: async () => {
      calls.dispatch += 1;
      return {
      ok: true,
      status: "ready",
      recentCallLimit: 1000,
      refreshedAt: "2026-10-03T00:00:00.000Z",
        accounts: [row, claudeRow, grokRow],
      };
    },
  } as never;
  const operations = {
    poolQualitySummary: async (platform: string) => platform === "claude"
      ? ({ ok: true, platform: "claude", groupIds: [119], score: 88, grade: "B" })
      : platform === "grok"
        ? ({ ok: true, platform: "grok", groupIds: [62], score: 86, grade: "B" })
        : ({ ok: true, platform: "codex", groupIds: [2, 3], score: 91, grade: "A" }),
    poolQualityErrors: async () => ({ ok: true, total: 0, rows: [] }),
    priorityHistory: async () => ({ ok: true, records: [] }),
    getPriorityAutomation: async () => ({ ok: true, automation: { enabled: false } }),
    upstreamQuotaSummary: async () => ({ ok: true, history: [], walletDistribution: [] }),
    getUpstreamUsageCache: async () => usageRows,
    idleProbeHistory: async () => ({ ok: true, records: [], pagination: { page: 1, totalPages: 1, total: 0 } }),
    getReadModelSnapshot: async () => null,
    saveReadModelSnapshot: async () => { calls.save += 1; },
  };
  return { config, row, claudeRow, grokRow, calls, operations, service: new UpstreamSchedulingV2Service(config, dispatcher, operations as never) };
}

describe("upstream scheduling v2", () => {
  test("projects Codex data and reports a matching read-only boundary", async () => {
    const { service, row } = fixture();
    const snapshot = await service.snapshot("codex");
    expect(snapshot.scope).toBe("codex");
    expect(snapshot.data.accounts).toHaveLength(1);
    expect(snapshot.data.accounts[0]).toMatchObject(row);
    expect(snapshot.data.accounts[0]).toMatchObject({
      quota: { unit: "USD", remaining: 12.5 },
      quotaCacheAt: "2026-10-03T00:01:00.000Z",
      quotaCacheStatus: "cached",
    });
    expect(snapshot.data.quotaCoverage).toMatchObject({
      accountCount: 1,
      cachedAccountCount: 1,
      missingAccountIds: [],
      complete: true,
      source: "quota-monitor-usage-cache",
    });
    expect(snapshot.reconciliation.status).toBe("matched");
    expect(snapshot.reconciliation.checks.find((check) => check.name === "write-boundary")?.status).toBe("matched");
    expect(snapshot.readOnly).toBeTrue();
  });

  test("generates a plan without enabling apply", async () => {
    const { service } = fixture();
    const plan = await service.plan("codex");
    expect(plan.apply).toEqual({ enabled: false, mutation: false, reason: "codex.features.planWrite=false" });
    expect(plan.scope).toBe("codex");
  });

  test("projects Claude data with the same read-only boundary", async () => {
    const { service, claudeRow } = fixture();
    const snapshot = await service.snapshot("claude");
    expect(snapshot.scope).toBe("claude");
    expect(snapshot.platform).toBe("anthropic");
    expect(snapshot.data.accounts).toHaveLength(1);
    expect(snapshot.data.accounts[0]).toMatchObject(claudeRow);
    expect(snapshot.data.accounts[0].quotaCacheStatus).toBe("missing");
    expect(snapshot.data.quotaCoverage).toMatchObject({
      accountCount: 1,
      cachedAccountCount: 0,
      missingAccountIds: [202],
      complete: false,
    });
    expect(snapshot.data.poolQuality.platform).toBe("claude");
    expect(snapshot.readOnly).toBeTrue();
    expect(snapshot.features).toMatchObject({
      scoreRead: true,
      planRead: true,
      planWrite: false,
      priorityAutomation: false,
      idleProbe: false,
      upstreamWrite: false,
    });
  });

  test("keeps cached unlimited and unavailable states explicit", async () => {
    const { service } = fixture([
      { account_id: 101, last_success_at: "2026-10-03T00:01:00.000Z", last_success_result: { ok: true, quota: { unit: "USD", remaining: 12.5 } } },
      { account_id: 202, queried_at: "2026-10-03T00:02:00.000Z", result: { ok: true, quota: { unlimited: true } } },
    ]);
    const snapshot = await service.snapshot("claude");
    expect(snapshot.data.accounts[0]).toMatchObject({
      quota: { remaining: null, unlimited: true },
      quotaCacheStatus: "unlimited",
    });
    expect(snapshot.data.quotaCoverage).toMatchObject({
      cachedAccountCount: 1,
      numericAccountCount: 0,
      unlimitedAccountCount: 1,
      unavailableAccountIds: [],
      missingAccountIds: [],
      complete: false,
      cacheRowsComplete: true,
    });
  });

  test("keeps Claude plans non-mutating", async () => {
    const { service } = fixture();
    const plan = await service.plan("claude");
    expect(plan.apply).toEqual({ enabled: false, mutation: false, reason: "claude.features.planWrite=false" });
    expect(plan.scope).toBe("claude");
  });

  test("projects Grok as an independent scope without probe history", async () => {
    const { service, grokRow } = fixture();
    const snapshot = await service.snapshot("grok");
    expect(snapshot.scope).toBe("grok");
    expect(snapshot.platform).toBe("grok");
    expect(snapshot.data.accounts).toHaveLength(1);
    expect(snapshot.data.accounts[0]).toMatchObject(grokRow);
    expect(snapshot.data.poolQuality).toMatchObject({ platform: "grok", groupIds: [62] });
    expect(snapshot.data.probeHistory.records).toHaveLength(0);
    expect(snapshot.readOnly).toBeTrue();
    const plan = await service.plan("grok");
    expect(plan.apply).toEqual({ enabled: false, mutation: false, reason: "grok.features.planWrite=false" });
  });

  test("serves a warm V2 snapshot from the read-model cache", async () => {
    const { service, calls } = fixture();
    const first = await service.snapshot("codex");
    const second = await service.snapshot("codex");
    expect(first.cache).toMatchObject({ state: "refreshed", ttlSeconds: 30 });
    expect(second.cache).toMatchObject({ state: "hit", ttlSeconds: 30 });
    expect(calls.dispatch).toBe(1);
    expect(calls.save).toBe(1);
  });

  test("deduplicates concurrent cold snapshot builds", async () => {
    const { service, calls, operations } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = operations.poolQualitySummary;
    operations.poolQualitySummary = async (...args: never[]) => {
      await gate;
      return await original(...args);
    };
    const first = service.snapshot("codex");
    const second = service.snapshot("codex");
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(left.scope).toBe("codex");
    expect(right.scope).toBe("codex");
    expect(calls.dispatch).toBe(1);
  });
});
