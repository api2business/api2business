import { expect, test } from "bun:test";
import { automationDispatchDelayMs } from "./priority-automation-dispatch";

test("automation waits locally until the scheduled run instead of submitting Temporal polls", () => {
  const now = Date.parse("2026-08-05T00:00:00Z");
  expect(automationDispatchDelayMs({
    enabled: true,
    nextRunAt: "2026-08-05T00:10:00Z",
    runId: null,
    runClaimedAt: null,
    runStartedAt: null,
  }, now, 600_000, 60_000)).toEqual({ due: false, delayMs: 60_000, reason: "waiting" });
});

test("automation dispatches due schedules and expired runs only", () => {
  const now = Date.parse("2026-08-05T00:10:00Z");
  expect(automationDispatchDelayMs({
    enabled: true, nextRunAt: "2026-08-05T00:10:00Z", runId: null,
    runClaimedAt: null, runStartedAt: null,
  }, now, 600_000, 60_000).reason).toBe("scheduled");
  expect(automationDispatchDelayMs({
    enabled: true, nextRunAt: "2026-08-05T00:00:00Z", runId: "run-1",
    runClaimedAt: "2026-08-04T23:59:00Z", runStartedAt: "2026-08-05T00:00:00Z",
  }, now, 600_000, 60_000).reason).toBe("expired-run");
});
