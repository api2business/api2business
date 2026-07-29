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
    async withPriorityOptimizationQueue<T>(
      operation: (lease: Record<string, unknown>) => Promise<T>,
    ) {
      return await operation({
        queueName: "priority-optimization-global",
        queuedAt: "2026-07-28T12:00:00.000Z",
        acquiredAt: "2026-07-28T12:00:00.010Z",
        waitMs: 10,
      });
    },
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
  const events: string[] = [];
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
      events.push("execution-started");
      executionStarted = true;
      return { execution_started_at: "2026-07-28T12:00:00.000Z" };
    },
    async finishPlan(_id: string, status: string, result: Record<string, unknown>) {
      events.push("plan-finished");
      finished.push({ status, result });
      return {
        execution_started_at: "2026-07-28T12:00:00.000Z",
        completed_at: "2026-07-28T12:00:10.000Z",
        next_run_at: "2026-07-28T13:00:10.000Z",
      };
    },
    async withPriorityOptimizationQueue<T>(operation: (lease: Record<string, unknown>) => Promise<T>) {
      events.push("queue-acquired");
      try {
        return await operation({
          queueName: "priority-optimization-global",
          queuedAt: "2026-07-28T12:00:00.000Z",
          acquiredAt: "2026-07-28T12:00:00.010Z",
          waitMs: 10,
        });
      } finally {
        events.push("queue-released");
      }
    },
    async audit() {
      events.push("plan-audited");
    },
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
    events.push(`batch-${batchNumber}`);
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
      queueName: "priority-optimization-global",
      waitMs: 10,
    },
  });
  expect(finished[0]).toMatchObject({ status: "applied" });
  expect(result).toMatchObject({
    executionStartedAt: "2026-07-28T12:00:00.000Z",
    completedAt: "2026-07-28T12:00:10.000Z",
    nextAutomaticRunAt: "2026-07-28T13:00:10.000Z",
  });
  expect(events).toEqual([
    "queue-acquired",
    "execution-started",
    "batch-1",
    "batch-2",
    "batch-3",
    "plan-finished",
    "plan-audited",
    "queue-released",
  ]);
});

test("codex profile writes finish before grok profile writes start", async () => {
  const priorities = { "1": 100, "2": 200 };
  const changes = [
    { accountId: 1, profile: "codex", beforePriority: 300 },
    { accountId: 2, profile: "grok", beforePriority: 400 },
  ];
  const events: string[] = [];
  const store = {
    async withPriorityOptimizationQueue<T>(operation: (lease: Record<string, unknown>) => Promise<T>) {
      return await operation({
        queueName: "priority-optimization-global",
        queuedAt: "2026-07-28T12:00:00.000Z",
        acquiredAt: "2026-07-28T12:00:00.010Z",
        waitMs: 10,
      });
    },
    async getPlan() {
      return {
        status: "pending",
        expires_at: "2099-01-01T00:00:00.000Z",
        priorities,
        result: { changes },
      };
    },
    async markPlanExecutionStarted() {
      return { execution_started_at: "2026-07-28T12:00:00.000Z" };
    },
    async finishPlan() {
      return {
        execution_started_at: "2026-07-28T12:00:00.000Z",
        completed_at: "2026-07-28T12:00:01.000Z",
        next_run_at: null,
      };
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
      },
    },
  } as AppConfig;
  const service = new OperationsService(config, store, unusedReads);
  const internals = service as unknown as {
    applyPriorityBatch(
      batch: Record<string, number>,
    ): Promise<Record<string, unknown> & { ok: boolean }>;
  };
  internals.applyPriorityBatch = async (batch) => {
    const profile = Object.hasOwn(batch, "1") ? "codex" : "grok";
    events.push(`${profile}:start`);
    await Bun.sleep(2);
    events.push(`${profile}:end`);
    return {
      ok: true,
      changedCount: Object.keys(batch).length,
      verification: "native-api-read-broker",
      verifiedCount: Object.keys(batch).length,
    };
  };

  await service.confirmPriorityPlan("plan-1", "tester");
  expect(events).toEqual([
    "codex:start",
    "codex:end",
    "grok:start",
    "grok:end",
  ]);
});

test("priority history emits one combined codex and grok row with pool breakdown", async () => {
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
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toEqual(expect.objectContaining({
    id: "plan-1",
    profile: "combined",
    profiles: ["codex", "grok"],
    changed_count: 2,
    candidate_changed_count: 2,
    profile_changed_counts: { codex: 1, grok: 1 },
    profile_candidate_changed_counts: { codex: 1, grok: 1 },
    profile_write_batch_counts: { codex: 1, grok: 1 },
    started_at: "2026-07-28T12:00:05.000Z",
    duration_ms: 10_000,
  }));
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

test("a waiting optimization cannot start scoring until the previous automatic flow is fully completed", async () => {
  const events: string[] = [];
  let queueTail = Promise.resolve();
  let queueSequence = 0;
  let planSequence = 0;
  let resolveFirstAcquired = () => {};
  const firstAcquired = new Promise<void>((resolve) => {
    resolveFirstAcquired = resolve;
  });
  const store = {
    async claimDueAutomation() {
      events.push("claimed");
      return { run_id: "run-1", recent_call_limit: 1000 };
    },
    async withPriorityOptimizationQueue<T>(
      operation: (lease: Record<string, unknown>) => Promise<T>,
    ) {
      const sequence = ++queueSequence;
      events.push(`queued:${sequence}`);
      const previous = queueTail;
      let release = () => {};
      queueTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      events.push(`acquired:${sequence}`);
      if (sequence === 1) resolveFirstAcquired();
      try {
        return await operation({
          queueName: "priority-optimization-global",
          queuedAt: `queued-${sequence}`,
          acquiredAt: `acquired-${sequence}`,
          waitMs: sequence === 1 ? 0 : 10,
        });
      } finally {
        events.push(`released:${sequence}`);
        release();
      }
    },
    async markAutomationRunStarted() {
      events.push("automation-started");
      return { run_started_at: "2026-07-28T12:00:00.000Z" };
    },
    async createPlan(input: Record<string, unknown>) {
      const id = `plan-${++planSequence}`;
      events.push(`plan-created:${String(input.triggerType)}`);
      return { id, expiresAt: "2026-07-28T12:15:00.000Z" };
    },
    async finishPlan() {
      events.push("plan-finished");
      return {
        execution_started_at: "2026-07-28T12:00:00.000Z",
        completed_at: "2026-07-28T12:00:01.000Z",
        next_run_at: null,
      };
    },
    async audit(action: string) {
      if (action === "priority.plan.generate") events.push("plan-audited");
      if (action === "priority.automation.run") events.push("automation-audited");
    },
    async completeAutomationRun(_runId: string, _jitterPercent: number, status: string) {
      events.push(`automation-completed:${status}`);
      return { id: "default" };
    },
  } as unknown as OperationsStore;
  const config = {
    operations: {
      planTtlMinutes: 15,
      automationJitterPercent: 0.1,
      automationSafety,
      priorityWrite: {
        batchSize: 3,
      },
    },
  } as AppConfig;
  const service = new OperationsService(config, store, unusedReads);
  service.priorityState = async (_limit, priority) => {
    events.push(`score-started:${priority}`);
    if (priority === "automatic") await Bun.sleep(10);
    events.push(`score-finished:${priority}`);
    return {
      queryDurationMs: 10,
      eligibleCount: 2,
      changedCount: 0,
      priorities: {},
      changes: [],
      profiles: {
        codex: { changedCount: 0 },
        grok: { changedCount: 0 },
      },
    };
  };

  const automatic = service.runDueAutomation();
  await firstAcquired;
  const manual = service.generatePriorityPlan(1000, "tester");
  await Promise.all([automatic, manual]);

  const automaticCompleted = events.indexOf("automation-completed:succeeded");
  const automaticReleased = events.indexOf("released:1");
  const manualAcquired = events.indexOf("acquired:2");
  const manualScoreStarted = events.indexOf("score-started:manual");
  expect(events.indexOf("automation-started")).toBeGreaterThan(events.indexOf("acquired:1"));
  expect(automaticCompleted).toBeGreaterThan(events.indexOf("automation-audited"));
  expect(automaticReleased).toBeGreaterThan(automaticCompleted);
  expect(manualAcquired).toBeGreaterThan(automaticReleased);
  expect(manualScoreStarted).toBeGreaterThan(manualAcquired);
});

test("an automatic changed plan uses one full-flow queue lease through writeback and completion", async () => {
  const events: string[] = [];
  const priorities = { "1": 120 };
  const changes = [{
    accountId: 1,
    beforePriority: 300,
    desiredPriority: 120,
    profile: "codex",
  }];
  const store = {
    async claimDueAutomation() {
      return { run_id: "run-1", recent_call_limit: 1000 };
    },
    async withPriorityOptimizationQueue<T>(
      operation: (lease: Record<string, unknown>) => Promise<T>,
    ) {
      events.push("acquired");
      try {
        return await operation({
          queueName: "priority-optimization-global",
          queuedAt: "queued",
          acquiredAt: "acquired",
          waitMs: 0,
        });
      } finally {
        events.push("released");
      }
    },
    async markAutomationRunStarted() {
      events.push("started");
      return { run_started_at: "2026-07-28T12:00:00.000Z" };
    },
    async createPlan() {
      events.push("plan-created");
      return { id: "plan-1", expiresAt: "2099-01-01T00:15:00.000Z" };
    },
    async getPlan() {
      return {
        status: "pending",
        expires_at: "2099-01-01T00:15:00.000Z",
        priorities,
        result: { changes },
      };
    },
    async finishPlan() {
      events.push("plan-finished");
      return {
        execution_started_at: "2026-07-28T12:00:00.000Z",
        completed_at: "2026-07-28T12:00:01.000Z",
        next_run_at: null,
      };
    },
    async audit(action: string) {
      if (action === "priority.plan.confirm") events.push("confirmation-audited");
      if (action === "priority.automation.run") events.push("automation-audited");
    },
    async completeAutomationRun() {
      events.push("automation-completed");
      return { id: "default" };
    },
  } as unknown as OperationsStore;
  const config = {
    operations: {
      planTtlMinutes: 15,
      automationJitterPercent: 0.1,
      automationSafety,
      priorityWrite: {
        batchSize: 3,
        interBatchMinimumDelayMs: 0,
        interBatchMaximumDelayMs: 0,
        maximumRetries: 3,
      },
    },
  } as AppConfig;
  const service = new OperationsService(config, store, unusedReads);
  service.priorityState = async () => ({
    queryDurationMs: 10,
    eligibleCount: 2,
    changedCount: 1,
    priorities,
    changes,
    profiles: { codex: { changedCount: 1 } },
  });
  const internals = service as unknown as {
    applyPriorityBatch(): Promise<Record<string, unknown> & { ok: boolean }>;
  };
  internals.applyPriorityBatch = async () => {
    events.push("write-and-readback");
    return {
      ok: true,
      changedCount: 1,
      verification: "native-api-read-broker",
      verifiedCount: 1,
    };
  };

  const result = await service.runDueAutomation();
  expect(result).toMatchObject({
    due: true,
    changedCount: 1,
    queue: {
      queueName: "priority-optimization-global",
    },
  });
  expect(events).toEqual([
    "acquired",
    "started",
    "plan-created",
    "write-and-readback",
    "plan-finished",
    "confirmation-audited",
    "automation-audited",
    "automation-completed",
    "released",
  ]);
});

test("a blocked automatic cycle remains inside the full optimization queue through completion", async () => {
  const events: string[] = [];
  const store = {
    async claimDueAutomation() {
      return { run_id: "run-1", recent_call_limit: 1000 };
    },
    async withPriorityOptimizationQueue<T>(
      operation: (lease: Record<string, unknown>) => Promise<T>,
    ) {
      events.push("acquired");
      try {
        return await operation({
          queueName: "priority-optimization-global",
          queuedAt: "queued",
          acquiredAt: "acquired",
          waitMs: 0,
        });
      } finally {
        events.push("released");
      }
    },
    async markAutomationRunStarted() {
      events.push("started");
      return { run_started_at: "2026-07-28T12:00:00.000Z" };
    },
    async createPlan() {
      events.push("plan-created");
      return { id: "plan-1", expiresAt: "2026-07-28T12:15:00.000Z" };
    },
    async finishPlan() {
      events.push("plan-finished");
      return {
        execution_started_at: "2026-07-28T12:00:00.000Z",
        completed_at: "2026-07-28T12:00:01.000Z",
        next_run_at: null,
      };
    },
    async audit(action: string, status: string) {
      if (action === "priority.automation.run") events.push(`automation-audited:${status}`);
    },
    async completeAutomationRun() {
      events.push("automation-completed");
      return { id: "default" };
    },
  } as unknown as OperationsStore;
  const config = {
    operations: {
      planTtlMinutes: 15,
      automationJitterPercent: 0.1,
      automationSafety,
      priorityWrite: {
        batchSize: 3,
      },
    },
  } as AppConfig;
  const service = new OperationsService(config, store, unusedReads);
  service.priorityState = async () => ({
    ...candidatePlan(3500),
    profiles: { codex: { changedCount: 15 } },
  });

  const result = await service.runDueAutomation();
  expect(result).toMatchObject({
    due: true,
    writeMode: "cycle-skipped",
    queue: {
      queueName: "priority-optimization-global",
    },
  });
  expect(events).toEqual([
    "acquired",
    "started",
    "plan-created",
    "plan-finished",
    "automation-audited:blocked",
    "automation-completed",
    "released",
  ]);
});

test("an expired automatic cycle is recovered without starting another optimization", async () => {
  const events: string[] = [];
  const store = {
    async claimDueAutomation(runTimeoutMs: number, jitterPercent: number) {
      events.push(`claim:${runTimeoutMs}:${jitterPercent}`);
      return {
        recovered: true,
        plan_id: "plan-stale",
        writeMode: "cycle-timeout",
        reason: "automation-run-timeout",
        next_run_at: "2026-07-29T12:30:00.000Z",
        last_completed_at: "2026-07-29T12:00:00.000Z",
      };
    },
    async withPriorityOptimizationQueue() {
      events.push("unexpected-queue-entry");
      throw new Error("recovery must not start a new optimization");
    },
  } as unknown as OperationsStore;
  const config = {
    operations: {
      automationRunTimeoutMs: 600000,
      automationJitterPercent: 0.1,
    },
  } as AppConfig;
  const service = new OperationsService(config, store, unusedReads);

  const result = await service.runDueAutomation();

  expect(result).toEqual({
    ok: true,
    due: false,
    recovered: true,
    planId: "plan-stale",
    writeMode: "cycle-timeout",
    reason: "automation-run-timeout",
    nextRunAt: "2026-07-29T12:30:00.000Z",
    completedAt: "2026-07-29T12:00:00.000Z",
  });
  expect(events).toEqual(["claim:600000:0.1"]);
});
