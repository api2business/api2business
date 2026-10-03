import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";
import { UpstreamSchedulingV2Error, UpstreamSchedulingV2Service } from "./upstream-scheduling-v2";

function fixture() {
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
  const dispatcher = {
    dispatch: async () => ({
      ok: true,
      status: "ready",
      recentCallLimit: 1000,
      refreshedAt: "2026-10-03T00:00:00.000Z",
      accounts: [row],
    }),
  } as never;
  const operations = {
    poolQualitySummary: async () => ({ ok: true, platform: "codex", groupIds: [2, 3], score: 91, grade: "A" }),
    poolQualityErrors: async () => ({ ok: true, total: 0, rows: [] }),
    priorityHistory: async () => ({ ok: true, records: [] }),
    getPriorityAutomation: async () => ({ ok: true, automation: { enabled: false } }),
    upstreamQuotaSummary: async () => ({ ok: true, history: [], walletDistribution: [] }),
    getUpstreamUsageCache: async () => [],
    idleProbeHistory: async () => ({ ok: true, records: [], pagination: { page: 1, totalPages: 1, total: 0 } }),
  } as never;
  return { config, row, service: new UpstreamSchedulingV2Service(config, dispatcher, operations) };
}

describe("upstream scheduling v2", () => {
  test("projects Codex data and reports a matching read-only boundary", async () => {
    const { service, row } = fixture();
    const snapshot = await service.snapshot("codex");
    expect(snapshot.scope).toBe("codex");
    expect(snapshot.data.accounts).toEqual([row]);
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

  test("does not expose the disabled Claude scope", async () => {
    const { service } = fixture();
    await expect(service.snapshot("claude")).rejects.toBeInstanceOf(UpstreamSchedulingV2Error);
  });
});
