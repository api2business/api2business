import { expect, test } from "bun:test";
import { scoreScheduleFreshness } from "./score-schedule-watchdog";

test("keeps a recently persisted score snapshot fresh", () => {
  expect(scoreScheduleFreshness({
    nowMs: Date.parse("2026-08-10T16:10:00Z"),
    workerStartedAtMs: Date.parse("2026-08-10T16:00:00Z"),
    capturedAt: "2026-08-10T16:09:00Z",
    intervalMinutes: 5,
    activityTimeoutMs: 60_000,
  })).toMatchObject({ stale: false, ageMs: 60_000, reference: "captured-snapshot" });
});

test("marks a score schedule stale after three intervals and activity budget", () => {
  expect(scoreScheduleFreshness({
    nowMs: Date.parse("2026-08-10T16:16:01Z"),
    workerStartedAtMs: Date.parse("2026-08-10T16:00:00Z"),
    capturedAt: "2026-08-10T16:00:00Z",
    intervalMinutes: 5,
    activityTimeoutMs: 60_000,
  }).stale).toBe(true);
});

test("uses worker startup as the initial grace period", () => {
  expect(scoreScheduleFreshness({
    nowMs: Date.parse("2026-08-10T16:14:59Z"),
    workerStartedAtMs: Date.parse("2026-08-10T16:00:00Z"),
    capturedAt: null,
    intervalMinutes: 5,
    activityTimeoutMs: 60_000,
  }).stale).toBe(false);
});
