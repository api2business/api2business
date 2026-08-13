import { expect, test } from "bun:test";
import { retirementSelectionMode, summarizeLifecycleResponse } from "./cli";

test("maps explicit full-pool selection to the existing database-all lifecycle mode", () => {
  expect(retirementSelectionMode(null, "pool", "team")).toBe("database-dead");
  expect(retirementSelectionMode("all", "pool", "team")).toBe("database-all");
  expect(() => retirementSelectionMode("all", "day", "team")).toThrow("--scope pool");
  expect(() => retirementSelectionMode("all", "pool", "all")).toThrow("one explicit --plan-type");
});

test("summarizes retirement plans without expanding candidates", () => {
  const summary = summarizeLifecycleResponse({
    ok: true,
    target: "native-api",
    transport: "http",
    job: {
      id: "plan-1",
      state: "succeeded",
      settings: { day: "2026-07-31", selectionMode: "database-error" },
      candidates: [{ accountId: 1 }, { accountId: 2 }],
      result: { summary: { dead: 2, excludedRateLimited: 3 } },
      logs: [{ stage: "candidates", state: "done", message: "ok" }],
      settlement: null,
      error: null,
    },
  });
  expect(summary.candidateCount).toBe(2);
  expect(summary.excludedRateLimited).toBe(3);
  expect(summary).not.toHaveProperty("candidates");
  expect(summary.next).toContain("retire confirm --id plan-1 --confirm");
});
