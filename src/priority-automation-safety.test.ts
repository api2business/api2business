import { expect, test } from "bun:test";
import {
  buildPriorityWriteBatches,
  buildPriorityWriteProfileQueues,
  exponentialRetryDelayMs,
  preparePriorityAutomationBatch,
  randomIntervalMs,
} from "./priority-automation-safety";

const policy = {
  maximumScoreQueryDurationMs: 3000,
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
  }, policy, 3)).toMatchObject({
    allowed: true,
    mode: "paced",
    blockedReasons: [],
    batchingReasons: ["paced-write-required"],
    selectedChangedCount: 4,
    notSelectedChangedCount: 0,
    writeBatchSize: 3,
    writeBatchCount: 2,
    changedFraction: 0.333333,
  });
});

test("automatic priority safety blocks only the slow cycle", () => {
  expect(preparePriorityAutomationBatch({
    queryDurationMs: 12000,
    eligibleCount: 17,
    priorities: { "1": 100, "2": 200 },
  }, policy, 3)).toMatchObject({
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
  const plan = {
    queryDurationMs: 800,
    eligibleCount: 17,
    priorities,
    changes,
  };
  const result = preparePriorityAutomationBatch(plan, policy, 3);

  expect(result).toMatchObject({
    allowed: true,
    mode: "paced",
    blockedReasons: [],
    batchingReasons: ["paced-write-required"],
    fullChangedCount: 15,
    selectedChangedCount: 15,
    notSelectedChangedCount: 0,
    writeBatchSize: 3,
    writeBatchCount: 5,
  });
  expect(Object.keys(result.selectedPriorities as Record<string, number>).slice(0, 3)).toEqual(["1", "2", "3"]);
  expect(buildPriorityWriteBatches(plan, 3)).toHaveLength(5);
  expect(Object.keys(buildPriorityWriteBatches(plan, 3)[0]!)).toEqual(["1", "2", "3"]);
});

test("priority writes use random inter-batch intervals and jittered exponential retries", () => {
  expect(randomIntervalMs(3000, 9000, () => 0)).toBe(3000);
  expect(randomIntervalMs(3000, 9000, () => 0.5)).toBe(6000);
  expect(exponentialRetryDelayMs(2000, 1, 0.2, () => 0.5)).toBe(2000);
  expect(exponentialRetryDelayMs(2000, 2, 0.2, () => 0.5)).toBe(4000);
  expect(exponentialRetryDelayMs(2000, 3, 0.2, () => 0.5)).toBe(8000);
});

test("codex and grok writes use separate non-overlapping profile queues", () => {
  const queues = buildPriorityWriteProfileQueues({
    priorities: { "1": 300, "2": 100, "3": 400, "4": 200 },
    changes: [
      { accountId: 1, profile: "codex", beforePriority: 100 },
      { accountId: 2, profile: "grok", beforePriority: 300 },
      { accountId: 3, profile: "codex", beforePriority: 200 },
      { accountId: 4, profile: "grok", beforePriority: 400 },
    ],
  }, 3);

  expect(queues.map((queue) => queue.profile)).toEqual(["codex", "grok"]);
  expect(queues.map((queue) => queue.batches)).toEqual([
    [{ "1": 300, "3": 400 }],
    [{ "2": 100, "4": 200 }],
  ]);
});
