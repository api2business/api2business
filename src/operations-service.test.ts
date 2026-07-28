import { expect, test } from "bun:test";
import type { AppConfig } from "./config";
import { OperationsService } from "./operations-service";
import type { OperationsStore } from "./operations-store";

const automationSafety = {
  maximumScoreQueryDurationMs: 3000,
  maximumChangedAccounts: 8,
  maximumChangedFraction: 0.5,
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
    operations: { planTtlMinutes: 15, automationSafety },
  } as AppConfig;
  const service = new OperationsService(config, store, "postgres://unused");
  service.priorityState = async () => candidate;
  return { service, created };
}

test("automatic plans persist only the current bounded batch without a deferred queue", async () => {
  const fixture = serviceFixture(candidatePlan());
  const result = await fixture.service.generatePriorityPlan(500, "scheduler", "automatic");
  const persisted = fixture.created[0]!;

  expect(result).toMatchObject({
    changedCount: 8,
    candidateChangedCount: 15,
    notSelectedChangedCount: 7,
    automationSafety: {
      allowed: true,
      mode: "bounded",
      selectedChangedCount: 8,
      notSelectedChangedCount: 7,
    },
  });
  expect(Object.keys(persisted.priorities as Record<string, number>)).toHaveLength(8);
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
