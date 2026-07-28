import { expect, test } from "bun:test";
import { preparePriorityAutomationBatch } from "./priority-automation-safety";

const policy = {
  maximumScoreQueryDurationMs: 3000,
  maximumChangedAccounts: 8,
  maximumChangedFraction: 0.5,
};

test("automatic priority safety allows a bounded healthy plan", () => {
  expect(preparePriorityAutomationBatch({
    queryDurationMs: 800,
    changedCount: 4,
    eligibleCount: 12,
    priorities: { "1": 100, "2": 200, "3": 300, "4": 400 },
    changes: [
      { accountId: 1, beforePriority: 90 },
      { accountId: 2, beforePriority: 190 },
      { accountId: 3, beforePriority: 290 },
      { accountId: 4, beforePriority: 390 },
    ],
  }, policy)).toMatchObject({
    allowed: true,
    mode: "full",
    blockedReasons: [],
    batchingReasons: [],
    selectedChangedCount: 4,
    notSelectedChangedCount: 0,
    changedFraction: 0.333333,
  });
});

test("automatic priority safety blocks only the slow cycle", () => {
  expect(preparePriorityAutomationBatch({
    queryDurationMs: 12000,
    eligibleCount: 17,
    priorities: { "1": 100, "2": 200 },
  }, policy)).toMatchObject({
    allowed: false,
    mode: "blocked",
    blockedReasons: ["score-query-slow-or-unknown"],
    selectedChangedCount: 0,
    notSelectedChangedCount: 2,
    selectedPriorities: {},
  });
});

test("automatic priority safety converges broad changes in deterministic batches", () => {
  const priorities = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [String(index + 1), 100 + index]));
  const changes = Array.from({ length: 15 }, (_, index) => ({
    accountId: index + 1,
    beforePriority: index < 3 ? 1 : 200 + index,
  }));
  const result = preparePriorityAutomationBatch({
    queryDurationMs: 800,
    eligibleCount: 17,
    priorities,
    changes,
  }, policy);

  expect(result).toMatchObject({
    allowed: true,
    mode: "bounded",
    blockedReasons: [],
    batchingReasons: [
      "changed-account-limit-exceeded",
      "changed-fraction-limit-exceeded",
    ],
    fullChangedCount: 15,
    selectedChangedCount: 8,
    notSelectedChangedCount: 7,
  });
  expect(Object.keys(result.selectedPriorities as Record<string, number>).slice(0, 3)).toEqual(["1", "2", "3"]);
});
