import { expect, test } from "bun:test";
import { idleProbeScheduleFreshness } from "./idle-probe-schedule-watchdog";

test("keeps a progressing automatic idle probe schedule", () => {
  expect(idleProbeScheduleFreshness({
    nowMs: Date.parse("2026-08-08T03:10:00Z"),
    workerStartedAtMs: Date.parse("2026-08-08T03:00:00Z"),
    lastAutomaticCompletedAt: "2026-08-08T03:08:30Z",
    intervalSeconds: 60,
    roundTimeoutSeconds: 30,
  })).toEqual({
    stale: false,
    ageMs: 90_000,
    staleAfterMs: 210_000,
    reference: "last-automatic-round",
  });
});

test("marks a schedule stale after three intervals plus one round timeout", () => {
  expect(idleProbeScheduleFreshness({
    nowMs: Date.parse("2026-08-08T03:12:01Z"),
    workerStartedAtMs: Date.parse("2026-08-08T03:00:00Z"),
    lastAutomaticCompletedAt: "2026-08-08T03:08:30Z",
    intervalSeconds: 60,
    roundTimeoutSeconds: 30,
  }).stale).toBe(true);
});

test("uses worker startup as grace period before the first recorded round", () => {
  const input = {
    workerStartedAtMs: Date.parse("2026-08-08T03:00:00Z"),
    lastAutomaticCompletedAt: null,
    intervalSeconds: 60,
    roundTimeoutSeconds: 30,
  };
  expect(idleProbeScheduleFreshness({ ...input, nowMs: Date.parse("2026-08-08T03:03:00Z") }).stale).toBe(false);
  expect(idleProbeScheduleFreshness({ ...input, nowMs: Date.parse("2026-08-08T03:03:31Z") })).toMatchObject({
    stale: true,
    reference: "worker-start",
  });
});
