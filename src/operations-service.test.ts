import { expect, test } from "bun:test";
import type { AppConfig } from "./config";
import { OperationsService } from "./operations-service";
import type { OperationsStore } from "./operations-store";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

const unusedReads = {} as Sub2ApiReadClient;

const automationSafety = {
  maximumScoreQueryDurationMs: 3000,
};

function candidatePlan(queryDurationMs = 800) {
  const priorities = Object.fromEntries(
    Array.from({ length: 15 }, (_, index) => [String(index + 1), 100 + index]),
  );
  return {
    queryDurationMs,
    eligibleCount: 17,
    changedCount: 15,
    priorities,
    changes: Array.from({ length: 15 }, (_, index) => ({
      accountId: index + 1,
      beforePriority: index < 3 ? 1 : 200 + index,
      desiredPriority: 100 + index,
    })),
  };
}

function serviceFixture(candidate: Record<string, unknown>) {
  const created: Array<Record<string, unknown>> = [];
  const store = {
    async createPlan(input: Record<string, unknown>) {
      created.push(input);
      return { id: "plan-1", expiresAt: "2026-07-28T12:00:00.000Z" };
    },
    async audit() {},
  } as unknown as OperationsStore;
  const config = {
    operations: {
      planTtlMinutes: 15,
      automationSafety,
      priorityWrite: {
        batchSize: 3,
        interBatchMinimumDelayMs: 3000,
        interBatchMaximumDelayMs: 9000,
        maximumRetries: 3,
        retryInitialDelayMs: 2000,
        retryJitterPercent: 0.2,
      },
    },
  } as AppConfig;
  const service = new OperationsService(config, store, unusedReads);
  service.priorityState = async () => candidate;
  return { service, created };
}

test("automatic plans persist one fresh plan for paced writes without a deferred queue", async () => {
  const fixture = serviceFixture(candidatePlan());
  const result = await fixture.service.generatePriorityPlan(500, "scheduler", "automatic");
  const persisted = fixture.created[0]!;

  expect(result).toMatchObject({
    changedCount: 15,
    candidateChangedCount: 15,
    notSelectedChangedCount: 0,
    automationSafety: {
      allowed: true,
      mode: "paced",
      selectedChangedCount: 15,
      notSelectedChangedCount: 0,
      writeBatchSize: 3,
      writeBatchCount: 5,
    },
  });
  expect(Object.keys(persisted.priorities as Record<string, number>)).toHaveLength(15);
  expect(persisted.result).not.toHaveProperty("candidatePriorities");
  expect((persisted.result as Record<string, unknown>).automationSafety).not.toHaveProperty("selectedPriorities");
  expect((persisted.result as Record<string, unknown>).automationSafety).not.toHaveProperty("notSelectedPriorities");
});

test("slow automatic plans persist an empty write batch and skip only that cycle", async () => {
  const fixture = serviceFixture(candidatePlan(3500));
  const result = await fixture.service.generatePriorityPlan(500, "scheduler", "automatic");

  expect(result).toMatchObject({
    changedCount: 0,
    candidateChangedCount: 15,
    notSelectedChangedCount: 15,
    automationSafety: {
      allowed: false,
      mode: "blocked",
      blockedReasons: ["score-query-slow-or-unknown"],
    },
  });
  expect(fixture.created[0]!.priorities).toEqual({});
});

test("confirming nine changes writes three sequential rounds of three", async () => {
  const priorities = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [String(index + 1), 100 + index]));
  const appliedBatches: Array<Record<string, number>> = [];
  const finished: Array<Record<string, unknown>> = [];
  let executionStarted = false;
  const store = {
    async getPlan() {
      return {
        status: "pending",
        expires_at: "2099-01-01T00:00:00.000Z",
        priorities,
        result: { changes: candidatePlan().changes },
      };
    },
    async markPlanExecutionStarted() {
      executionStarted = true;
      return { execution_started_at: "2026-07-28T12:00:00.000Z" };
    },
    async finishPlan(_id: string, status: string, result: Record<string, unknown>) {
      finished.push({ status, result });
      return {
        execution_started_at: "2026-07-28T12:00:00.000Z",
        completed_at: "2026-07-28T12:00:10.000Z",
        next_run_at: "2026-07-28T13:00:10.000Z",
      };
    },
    async withPriorityWriteQueue<T>(operation: (lease: Record<string, unknown>) => Promise<T>) {
      return await operation({
        queueName: "priority-write-global",
        queuedAt: "2026-07-28T12:00:00.000Z",
        acquiredAt: "2026-07-28T12:00:00.010Z",
        waitMs: 10,
      });
    },
    async audit() {},
  } as unknown as OperationsStore;
  const config = {
    operations: {
      automationJitterPercent: 0.1,
      priorityWrite: {
        batchSize: 3,
        interBatchMinimumDelayMs: 0,
        interBatchMaximumDelayMs: 0,
        maximumRetries: 3,
        retryInitialDelayMs: 0,
        retryJitterPercent: 0,
      },
    },
  } as AppConfig;
  const service = new OperationsService(config, store, unusedReads);
  const internals = service as unknown as {
    applyPriorityBatch(
      batch: Record<string, number>,
      batchNumber: number,
      batchCount: number,
    ): Promise<Record<string, unknown> & { ok: boolean }>;
  };
  internals.applyPriorityBatch = async (batch, batchNumber, batchCount) => {
    appliedBatches.push(batch);
    return {
      ok: true,
      batchNumber,
      batchCount,
      changedCount: Object.keys(batch).length,
      verification: "native-api-read-broker",
      verifiedCount: Object.keys(batch).length,
    };
  };

  const result = await service.confirmPriorityPlan("plan-1", "tester");
  expect(executionStarted).toBeTrue();
  expect(appliedBatches.map((batch) => Object.keys(batch).length)).toEqual([3, 3, 3]);
  expect(result).toMatchObject({
    changedCount: 9,
    completedChangedCount: 9,
    batchSize: 3,
    batchCount: 3,
    completedBatchCount: 3,
    queue: {
      queueName: "priority-write-global",
      waitMs: 10,
    },
  });
  expect(finished[0]).toMatchObject({ status: "applied" });
  expect(result).toMatchObject({
    executionStartedAt: "2026-07-28T12:00:00.000Z",
    completedAt: "2026-07-28T12:00:10.000Z",
    nextAutomaticRunAt: "2026-07-28T13:00:10.000Z",
  });
});

test("priority history emits separate codex and grok rows with elapsed time", async () => {
  const store = {
    async priorityHistory() {
      return [{
        id: "plan-1",
        created_at: "2026-07-28T12:00:00.000Z",
        execution_started_at: "2026-07-28T12:00:05.000Z",
        completed_at: "2026-07-28T12:00:15.000Z",
        created_by: "scheduler",
        trigger_type: "automatic",
        status: "applied",
        recent_call_limit: 1000,
        priorities: { "1": 100, "2": 200 },
        result: {
          profiles: {
            codex: { changedCount: 1 },
            grok: { changedCount: 1 },
          },
          changes: [
            { accountId: 1, profile: "codex" },
            { accountId: 2, profile: "grok" },
          ],
        },
        apply_result: {
          batches: [
            { profile: "codex", ok: true },
            { profile: "grok", ok: true },
          ],
        },
      }];
    },
  } as unknown as OperationsStore;
  const config = {
    operations: { auditLimit: 100 },
  } as AppConfig;
  const service = new OperationsService(config, store, unusedReads);

  const result = await service.priorityHistory();
  expect(result.records).toHaveLength(2);
  expect(result.records).toEqual([
    expect.objectContaining({
      id: "plan-1:codex",
      profile: "codex",
      changed_count: 1,
      started_at: "2026-07-28T12:00:05.000Z",
      duration_ms: 10_000,
    }),
    expect.objectContaining({
      id: "plan-1:grok",
      profile: "grok",
      changed_count: 1,
      started_at: "2026-07-28T12:00:05.000Z",
      duration_ms: 10_000,
    }),
  ]);
});

test("one round stops after the initial write and three exponential retries", async () => {
  const config = {
    operations: {
      priorityVerificationTimeoutMs: 0,
      priorityVerificationPollMs: 0,
      priorityWrite: {
        batchSize: 3,
        interBatchMinimumDelayMs: 0,
        interBatchMaximumDelayMs: 0,
        maximumRetries: 3,
        retryInitialDelayMs: 0,
        retryJitterPercent: 0,
      },
    },
  } as AppConfig;
  const service = new OperationsService(config, {} as OperationsStore, unusedReads);
  let writes = 0;
  const internals = service as unknown as {
    writePriorityBatch(batch: Record<string, number>): Promise<Record<string, unknown> & { ok: boolean }>;
    verifyPriorities(batch: Record<string, number>, timeoutMs?: number): Promise<Record<string, unknown>>;
    applyPriorityBatch(
      batch: Record<string, number>,
      batchNumber: number,
      batchCount: number,
    ): Promise<Record<string, unknown> & { ok: boolean }>;
  };
  internals.writePriorityBatch = async () => {
    writes += 1;
    return { ok: false, exitCode: 1, timedOut: false, writeDurationMs: 1, outputAvailable: false, error: "failed" };
  };
  internals.verifyPriorities = async (batch) => ({
    complete: false,
    verification: "native-api-read-broker",
    verifiedCount: 0,
    verificationDurationMs: 1,
    unmatchedPriorities: batch,
  });

  const result = await internals.applyPriorityBatch({ "1": 100, "2": 200, "3": 300 }, 1, 1);
  expect(writes).toBe(4);
  expect(result).toMatchObject({
    ok: false,
    attemptCount: 4,
    retryCount: 3,
    unmatchedCount: 3,
  });
});

test("one round skips backend writes when broker preflight readback is already complete", async () => {
  const config = {
    operations: {
      priorityVerificationTimeoutMs: 0,
      priorityVerificationPollMs: 0,
      priorityWrite: {
        batchSize: 3,
        interBatchMinimumDelayMs: 0,
        interBatchMaximumDelayMs: 0,
        maximumRetries: 3,
        retryInitialDelayMs: 0,
        retryJitterPercent: 0,
      },
    },
  } as AppConfig;
  const service = new OperationsService(config, {} as OperationsStore, unusedReads);
  let writes = 0;
  const internals = service as unknown as {
    writePriorityBatch(batch: Record<string, number>): Promise<Record<string, unknown> & { ok: boolean }>;
    verifyPriorities(batch: Record<string, number>, timeoutMs?: number): Promise<Record<string, unknown>>;
    applyPriorityBatch(
      batch: Record<string, number>,
      batchNumber: number,
      batchCount: number,
    ): Promise<Record<string, unknown> & { ok: boolean }>;
  };
  internals.writePriorityBatch = async () => {
    writes += 1;
    return { ok: true, exitCode: 0, timedOut: false, writeDurationMs: 1, outputAvailable: true, error: "" };
  };
  internals.verifyPriorities = async (batch, timeoutMs) => ({
    complete: true,
    verification: "native-api-read-broker",
    verifiedCount: Object.keys(batch).length,
    verificationDurationMs: 1,
    unmatchedPriorities: {},
    timeoutMs,
  });

  const result = await internals.applyPriorityBatch({ "1": 100, "2": 200, "3": 300 }, 1, 1);
  expect(writes).toBe(0);
  expect(result).toMatchObject({
    ok: true,
    attemptCount: 0,
    retryCount: 0,
    reconciled: true,
    preflightVerifiedCount: 3,
  });
});

test("the next automatic interval starts only after queued writes fully complete", async () => {
  const events: string[] = [];
  const store = {
    async claimDueAutomation() {
      events.push("claimed");
      return { run_id: "run-1", recent_call_limit: 1000 };
    },
    async audit() {},
    async completeAutomationRun(_runId: string, _jitterPercent: number, status: string) {
      events.push(`completed:${status}`);
      return { id: "default" };
    },
  } as unknown as OperationsStore;
  const config = {
    operations: {
      automationJitterPercent: 0.1,
    },
  } as AppConfig;
  const service = new OperationsService(config, store, unusedReads);
  const methods = service as unknown as {
    generatePriorityPlan(): Promise<Record<string, unknown>>;
    confirmPriorityPlan(): Promise<Record<string, unknown>>;
  };
  methods.generatePriorityPlan = async () => ({
    planId: "plan-1",
    changedCount: 1,
    candidateChangedCount: 1,
    notSelectedChangedCount: 0,
    automationSafety: { allowed: true, mode: "full" },
    profiles: { codex: { changedCount: 1 } },
  });
  methods.confirmPriorityPlan = async () => {
    events.push("write-started");
    await Bun.sleep(10);
    events.push("write-finished");
    return {
      changedCount: 1,
      verification: "native-api-read-broker",
    };
  };

  await service.runDueAutomation();
  expect(events).toEqual([
    "claimed",
    "write-started",
    "write-finished",
    "completed:succeeded",
  ]);
});
