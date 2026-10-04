import { expect, test } from "bun:test";
import type { AppConfig } from "./config";
import { applyPlanTypeRefunds, filterAutomaticPriorityPlan, latestSuccessfulUsageByWallet, normalizeUpstreamWallet, OperationsService, upstreamBalanceRateByWallet } from "./operations-service";
import type { OperationsStore } from "./operations-store";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

const unusedReads = {} as Sub2ApiReadClient;

test("selects the latest successful USD snapshot by normalized upstream wallet", () => {
  expect(normalizeUpstreamWallet("https://wallet.example.com/v1/")).toBe("https://wallet.example.com");
  expect(normalizeUpstreamWallet("https://billing.example.com plus 0.05")).toBe("https://billing.example.com");
  const selected = latestSuccessfulUsageByWallet([
    { account_id: 49, queried_at: "2026-08-01T10:00:00Z", result: { ok: false, baseUrl: "https://wallet.example.com/v1" },
      last_success_at: "2026-08-01T09:30:00Z", last_success_result: { ok: true, baseUrl: "https://wallet.example.com/v1", quota: { unit: "USD", remaining: 13.95879651 } } },
    { account_id: 50, queried_at: "2026-08-01T09:00:00Z", result: { ok: true, baseUrl: "https://wallet.example.com", quota: { unit: "USD", remaining: 13.95879651 } } },
    { account_id: 51, queried_at: "2026-08-01T08:00:00Z", result: { ok: true, baseUrl: "https://wallet.example.com/v1/", quota: { unit: "USD", remaining: 12 } } },
    { account_id: 52, queried_at: "2026-08-01T11:00:00Z", result: { ok: true, baseUrl: "https://unknown.example", quota: { unit: "USD", remaining: null } } },
  ]);
  expect(selected.get("https://wallet.example.com")).toMatchObject({ quota: { remaining: 13.95879651 } });
  expect(selected.has("https://unknown.example")).toBe(false);
});

test("uses a wallet-specific upstream balance conversion rate", () => {
  const overrides = { "https://billing.example.com/v1": 0.1 };
  expect(upstreamBalanceRateByWallet("https://billing.example.com", 1, overrides)).toBe(0.1);
  expect(upstreamBalanceRateByWallet("https://other.example", 1, overrides)).toBe(1);
});

test("restores one operator-confirmed historical successful wallet snapshot", async () => {
  const restored: Array<Record<string, unknown>> = [];
  const store = {
    async restoreUpstreamUsageSuccess(accountId: number, result: Record<string, unknown>) {
      restored.push({ accountId, result });
    },
  } as unknown as OperationsStore;
  const service = new OperationsService({} as AppConfig, store, unusedReads);
  const result = await service.restoreUpstreamUsageSuccess({
    accountId: 49,
    baseUrl: "https://wallet.example.com/v1",
    remainingUsd: 13.95879651,
    confirm: true,
  });
  expect(result).toMatchObject({ mutation: true, accountId: 49, baseUrl: "https://wallet.example.com", remainingUsd: 13.95879651 });
  expect(restored[0]).toMatchObject({ accountId: 49, result: { ok: true, provider: "operator-confirmed-history" } });
});

test("plan type refunds make group weighted cost equal the net total", () => {
  const groups = applyPlanTypeRefunds([
    { planType: "k12", acquisitionCostCny: 148.6, apiAmountUsd: 520.6944195 },
    { planType: "plus", acquisitionCostCny: 102.8, apiAmountUsd: 601.3187743 },
  ], [
    { planType: "k12", amountCny: 33 },
    { planType: "k12", amountCny: 27 },
  ]);
  expect(groups[0]).toMatchObject({
    grossAcquisitionCostCny: 148.6,
    procurementRefundCny: 60,
    netAcquisitionCostCny: 88.6,
  });
  expect(groups[1]).toMatchObject({
    grossAcquisitionCostCny: 102.8,
    procurementRefundCny: 0,
    netAcquisitionCostCny: 102.8,
  });
  const output = groups.reduce((sum, group) => sum + Number(group.apiAmountUsd), 0);
  const weighted = groups.reduce((sum, group) => sum + Number(group.apiAmountUsd) * Number(group.cnyPerApiUsd), 0) / output;
  expect(weighted).toBeCloseTo(191.4 / output, 12);
});

const automationSafety = {
  maximumScoreQueryDurationMs: 3000,
};

test("automatic priority plans follow per-scope feature switches", () => {
  const plan = {
    priorities: { "1": 101, "2": 102, "3": 103 },
    changedCount: 3,
    profiles: {
      codex: { changedCount: 1 },
      claude: { changedCount: 1 },
    },
    changes: [
      { accountId: 1, profile: "codex", change: "update", desiredPriority: 101 },
      { accountId: 2, profile: "claude", change: "update", desiredPriority: 102 },
    ],
  };
  const config = {
    operations: {
      upstreamSchedulingV2: {
        enabled: true,
        scopes: {
          codex: { enabled: true, features: { priorityAutomation: true } },
          claude: { enabled: false, features: { priorityAutomation: true } },
        },
      },
    },
  } as unknown as AppConfig;

  expect(filterAutomaticPriorityPlan(plan, config)).toMatchObject({
    priorities: { "1": 101 },
    changedCount: 1,
    changes: [{ accountId: 1, profile: "codex" }],
    profiles: { codex: { changedCount: 1 } },
  });
});

test("V2 automatic priority plans persist only the requested scope", async () => {
  const created: Array<Record<string, unknown>> = [];
  const store = {
    async withPriorityOptimizationQueue<T>(operation: (lease: Record<string, unknown>) => Promise<T>) {
      return await operation({ queueName: "priority-optimization-global", queuedAt: "queued", acquiredAt: "acquired", waitMs: 0 });
    },
    async createPlan(input: Record<string, unknown>) {
      created.push(input);
      return { id: "v2-plan", expiresAt: "2026-10-03T00:15:00.000Z" };
    },
    async finishPlan() {
      return { execution_started_at: "2026-10-03T00:00:00.000Z", completed_at: "2026-10-03T00:00:01.000Z", next_run_at: null };
    },
    async audit() {},
  } as unknown as OperationsStore;
  const config = {
    operations: {
      writePolicy: { enabled: true, claudeEnabled: true },
      upstreamSchedulingV2: {
        enabled: true,
        defaultScope: "codex",
        automation: { intervalSeconds: 600, recentCallLimit: 1000 },
        scopes: {
          codex: {
            enabled: true, platform: "openai", eligibleGroupIds: [2],
            features: { scoreRead: true, planRead: true, planWrite: false, priorityAutomation: true, idleProbe: false, upstreamWrite: false },
          },
        },
      },
      planTtlMinutes: 15,
      automationJitterPercent: 0.1,
      automationSafety,
      priorityWrite: { batchSize: 3 },
    },
  } as unknown as AppConfig;
  const service = new OperationsService(config, store, unusedReads);
  service.v2PriorityState = async () => ({
    queryDurationMs: 10,
    profiles: { codex: { changedCount: 0 } },
    changes: [],
    priorities: {},
    changedCount: 1,
  });
  const result = await service.runV2AutomaticPriorityPlan("codex", 1000);
  expect(result).toMatchObject({ ok: true, scope: "codex", writeMode: "no-change" });
  expect(created[0]?.operator).toBe("v2-scheduler:codex");
  expect((created[0]?.result as Record<string, unknown>).profiles).toEqual({ codex: { changedCount: 0 } });
  expect(created[0]?.executionStartedAt).toBeString();
});

test("探活记录按轮次分页，不展开普通请求明细", async () => {
  let query: number[] = [];
  const store = {
    async idleProbeHistoryPage(limit: number, offset: number) {
      query = [limit, offset];
      return [{
        operation_id: "probe-round-2", trigger_type: "automatic",
        started_at: "2026-08-04T10:00:00Z", completed_at: "2026-08-04T10:00:12Z",
        status: "partial", planned_count: 10, ready_count: 9, attempted_count: 9,
        succeeded_count: 8, failed_count: 1, unready_count: 1, duration_ms: 12000,
        error_summary: null, total_count: 11,
      }];
    },
  } as unknown as OperationsStore;
  const service = new OperationsService({} as AppConfig, store, unusedReads);
  const result = await service.idleProbeHistory(2, 10);
  expect(query).toEqual([10, 10]);
  expect(result).toMatchObject({
    records: [{ planned: 10, ready: 9, succeeded: 8, failed: 1, durationMs: 12000 }],
    pagination: { page: 2, pageSize: 10, total: 11, totalPages: 2 },
  });
});
