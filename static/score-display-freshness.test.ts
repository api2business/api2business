import { expect, test } from "bun:test";
import { scorePayloadTimestamp, shouldApplyScorePayload } from "./score-display-freshness.js";

test("score display rejects an older snapshot after a newer manual query", () => {
  const manualRefreshedAt = "2026-07-28T12:53:06.859Z";
  expect(shouldApplyScorePayload(manualRefreshedAt, {
    refreshedAt: "2026-07-28T07:44:47.371Z",
  })).toBeFalse();
  expect(shouldApplyScorePayload(manualRefreshedAt, {
    refreshedAt: "invalid",
  })).toBeFalse();
  expect(shouldApplyScorePayload(manualRefreshedAt, {})).toBeFalse();
});

test("score display accepts equal or newer payloads and timestamp fallbacks", () => {
  const currentRefreshedAt = "2026-07-28T12:53:06.859Z";
  expect(shouldApplyScorePayload(currentRefreshedAt, {
    refreshedAt: currentRefreshedAt,
  })).toBeTrue();
  expect(shouldApplyScorePayload(currentRefreshedAt, {
    refreshedAt: "2026-07-28T12:54:00.000Z",
  })).toBeTrue();
  expect(shouldApplyScorePayload(null, {})).toBeTrue();
  expect(scorePayloadTimestamp({
    refreshedAt: "invalid",
    queryCompletedAt: "2026-07-28T12:54:00.000Z",
  })).toBe(Date.parse("2026-07-28T12:54:00.000Z"));
});
