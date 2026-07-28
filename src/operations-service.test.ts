import { expect, test } from "bun:test";
import type { AppConfig } from "./config";
import { OperationsService } from "./operations-service";
import type { OperationsStore } from "./operations-store";

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
  const service = new OperationsService(config, store, "postgres://unused");
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
  const store = {
    async getPlan() {
      return {
        status: "pending",
        expires_at: "2099-01-01T00:00:00.000Z",
        priorities,
        result: { changes: candidatePlan().changes },
      };
    },
    async finishPlan(_id: string, status: string, result: Record<string, unknown>) {
      finished.push({ status, result });
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
  const service = new OperationsService(config, store, "postgres://unused");
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
      verification: "postgresql-direct",
      verifiedCount: Object.keys(batch).length,
    };
  };

  const result = await service.confirmPriorityPlan("plan-1", "tester");
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
  const service = new OperationsService(config, {} as OperationsStore, "postgres://unused");
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
    verification: "postgresql-direct",
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

test("one round skips backend writes when direct preflight readback is already complete", async () => {
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
  const service = new OperationsService(config, {} as OperationsStore, "postgres://unused");
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
    verification: "postgresql-direct",
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
