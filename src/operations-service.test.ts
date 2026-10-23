import { writeFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { loadConfig, type AppConfig } from "./config";
import { accountPriorityTransition, applyPlanTypeRefunds, filterAutomaticPriorityPlan, latestSuccessfulUsageByWallet, normalizeUpstreamWallet, OperationsService, upstreamBalanceRateByWallet } from "./operations-service";
import type { OperationsStore } from "./operations-store";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

const unusedReads = {} as Sub2ApiReadClient;

test("priority history preserves interrupted partial-write uncertainty and verified counts", async () => {
  const store = { async priorityHistory() { return [
    { id: "interrupted", status: "failed", priorities: { "41": 279 },
      result: { changes: [{ accountId: 41, profile: "codex" }] },
      apply_result: { writeMode: "interrupted-execution", verification: "unknown-partial-write",
        reason: "previous-execution-ended-before-completion" } },
    { id: "applied", status: "applied", priorities: { "41": 279 }, result: {},
      apply_result: { writeMode: "backend-api-paced", verification: "native-api-read-broker",
        completedChangedCount: 1, verifiedCount: 1 } },
  ]; } } as unknown as OperationsStore;
  const service = new OperationsService({ operations: { auditLimit: 10 } } as AppConfig, store, unusedReads);
  const result = await service.priorityHistory();
  expect(result.records[0]).toMatchObject({ status: "failed", profile_statuses: { codex: "failed" },
    verification: "unknown-partial-write", verified_count: null, completed_changed_count: null,
    failure_reason: "previous-execution-ended-before-completion" });
  expect(result.records[1]).toMatchObject({ status: "applied", verified_count: 1,
    completed_changed_count: 1, verification: "native-api-read-broker" });
});

test("priority history account filter returns one transition and hides other accounts", async () => {
  const store = { async priorityHistory() { return [
    { id: "round-1", status: "applied", created_at: "2026-10-21T08:42:00.000Z",
      priorities: { "1534": 100, "41": 200 },
      result: { changes: [
        { accountId: 1534, profile: "codex", beforePriority: 132, desiredPriority: 100, change: -32, priorityMode: "dynamic", score: 80.1, failureRate: 0.02 },
        { account_id: 41, profile: "codex", before_priority: 200, desired_priority: 210, change: 10 },
      ] },
      apply_result: { writeMode: "backend-api-paced", verification: "native-api-read-broker", completedChangedCount: 2, verifiedCount: 2 } },
    { id: "round-2", status: "applied", created_at: "2026-10-21T13:53:00.000Z",
      priorities: { "41": 210 },
      result: { changes: [{ accountId: 41, profile: "codex", beforePriority: 200, desiredPriority: 210 }] },
      apply_result: {} },
  ]; } } as unknown as OperationsStore;
  const service = new OperationsService({ operations: { auditLimit: 10 } } as AppConfig, store, unusedReads);
  expect(accountPriorityTransition([{ account_id: "1534", before_priority: "237", desired_priority: 237, change: "noop" }], 1534))
    .toMatchObject({ before_priority: 237, desired_priority: 237, change: "noop" });
  expect(accountPriorityTransition([], 1534)).toBeNull();
  const filtered = await service.priorityHistory(1534);
  expect(filtered.account_id).toBe(1534);
  expect(filtered.transitions).toEqual([{
    created_at: "2026-10-21T08:42:00.000Z",
    status: "applied",
    profile: "codex",
    before_priority: 132,
    desired_priority: 100,
    change: -32,
    priority_mode: "dynamic",
    score: 80.1,
    failure_rate: 0.02,
  }]);
  const serialized = JSON.stringify(filtered);
  expect(serialized).not.toContain("priorities");
  expect(serialized).not.toContain("\"41\"");
  expect(serialized).not.toContain("request_body");
  const summary = await service.priorityHistory();
  expect(summary).not.toHaveProperty("account_id");
  expect(summary).not.toHaveProperty("transitions");
  expect(summary.records).toHaveLength(2);
  expect(summary.records[0]).not.toHaveProperty("priorities");
  expect(summary.records[0]).not.toHaveProperty("account_change");
});

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

test("wallet assets order actual balance observations before cache timestamps", () => {
  const results = [1, 2].map(accountId => ({ account_id: accountId,
    last_success_at: `2026-10-16T01:0${accountId}:00.000Z`,
    last_success_result: { ok: true, baseUrl: "https://wallet.example", queriedAt: "2026-10-16T01:00:00.000Z",
      walletBalance: { observedAt: `2026-10-16T00:0${3-accountId}:00.000Z`, sourceAccountId: accountId },
      quota: { unit: "USD", remaining: accountId === 1 ? 0 : 10 } } }));
  expect(latestSuccessfulUsageByWallet(results).get("https://wallet.example")).toMatchObject({ quota: { remaining: 0 } });
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
    observedAt: "2026-10-04T16:24:14.958Z",
    confirm: true,
  });
  expect(result).toMatchObject({ mutation: true, accountId: 49, baseUrl: "https://wallet.example.com", remainingUsd: 13.95879651 });
  expect(restored[0]).toMatchObject({ accountId: 49, result: { ok: true, provider: "operator-confirmed-history" } });
  expect(restored[0]).toMatchObject({ result: { queriedAt: "2026-10-04T16:24:14.958Z",
    walletBalance: { observedAt: "2026-10-04T16:24:14.958Z", sourceAccountId: 49 } } });
  await service.restoreUpstreamUsageSuccess({ accountId: 49, baseUrl: "https://wallet.example.com", remainingUsd: -0.00203599, observedAt: "2026-10-04T16:24:14.958Z", confirm: true });
  expect(restored[1]).toMatchObject({ result: { ok: true, quota: { remaining: -0.00203599 } } });
  await expect(service.restoreUpstreamUsageSuccess({ accountId: 49, baseUrl: "https://wallet.example.com", remainingUsd: null, confirm: true })).rejects.toThrow("有限 USD");
  await expect(service.restoreUpstreamUsageSuccess({ accountId: 49, baseUrl: "https://wallet.example.com", remainingUsd: 1, confirm: true })).rejects.toThrow("原观测时间");
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

test("探活轮次只持久化原生关联证据，不保留自由响应字段", async () => {
  const evidence = { accountId: 42, groupId: 51, model: "grok-test",
    startedAt: "2026-01-01T01:00:00Z", completedAt: "2026-01-01T01:00:01Z",
    clientRequestId: "native-id" };
  const timeoutEvidence = { ...evidence, accountId: 43, clientRequestId: null, requestId: "original-timeout-request" };
  let saved: Record<string, unknown> = {};
  const store = { async addIdleProbeRound(input: Record<string, unknown>) { saved = input; } } as unknown as OperationsStore;
  const service = new OperationsService({} as AppConfig, store, unusedReads);
  const probe = (service as unknown as { idleProbe: { run: () => Promise<Record<string, unknown>> } }).idleProbe;
  probe.run = async () => ({ ok: true, results: [
    { response: { ...evidence, apiKey: "must-not-persist", body: "must-not-persist" } },
    { response: { ...timeoutEvidence, ordinaryLogRecorded: false } },
    { response: { accountId: 43, clientRequestId: null } },
  ] });
  await service.runIdleProbe([], 1, { operationId: "original-round", triggerType: "manual", scope: "grok" });
  expect(saved.requestEvidence).toEqual([evidence, timeoutEvidence]);
  expect(JSON.stringify(saved)).not.toContain("must-not-persist");
});

test("pool quality keeps successful scopes when one platform times out", async () => {
  const ledgerPath = "/tmp/a2b-pool-quality-ledger.yaml";
  writeFileSync(ledgerPath, "profit:\n  upstreamBalanceCnyPerApiUsd: 1\n");
  const config = loadConfig("config/api2business.example.yaml");
  config.operations.ledgerYamlPath = ledgerPath;
  const saved: string[] = [];
  const store = {
    async getUpstreamUsageCache() { return []; },
    async addPoolQualitySample(sample: { platform: string }) { saved.push(sample.platform); },
  } as unknown as OperationsStore;
  const usageRow = {
    id: 1, kind: "usage", request_id: "ok", account_id: 10, account_name: "account",
    base_url: "https://account", stream: true, first_token_ms: 1000, duration_ms: 2000,
    scoreable: false, failover_triggered: false,
  };
  const reads = {
    async query(input: { parameters: unknown[] }) {
      if (input.parameters[3] === "codex") {
        throw new Error("sub2api_read_query_timeout: query pool-quality-sample exceeded 15000ms");
      }
      return {
        rows: Array.from({ length: 1000 }, (_, index) => ({ ...usageRow, id: index + 1, request_id: `ok-${index}` })),
        cached: false, deduplicated: false, queueDurationMs: 0, queryDurationMs: 1,
        totalDurationMs: 1, queryStartedAt: new Date().toISOString(), queryCompletedAt: new Date().toISOString(),
      };
    },
    status() { throw new Error("not used"); },
  } as unknown as Sub2ApiReadClient;
  const service = new OperationsService(config, store, reads);
  const partial = await service.samplePoolQuality();
  expect(saved).toEqual(["claude", "grok", "deepseek"]);
  expect(partial.ok).toBe(false);
  expect(partial.failures).toEqual([{
    platform: "codex",
    error: "sub2api_read_query_timeout: query pool-quality-sample exceeded 15000ms",
  }]);
  const failingReads = {
    async query() { throw new Error("sub2api_read_query_timeout: query pool-quality-sample exceeded 15000ms"); },
    status() { throw new Error("not used"); },
  } as unknown as Sub2ApiReadClient;
  const failing = new OperationsService(config, store, failingReads);
  saved.length = 0;
  await expect(failing.samplePoolQuality()).rejects.toThrow("codex:");
  expect(saved).toEqual([]);
});
