import { expect, test } from "bun:test";
import { scoreFreshnessLabel, scorePayloadTimestamp, shouldApplyScorePayload } from "./score-display-freshness.js";

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

test("score freshness renders a second-level rolling age from the snapshot timestamp", () => {
  const now = Date.parse("2026-08-09T10:10:00.000Z");
  expect(scoreFreshnessLabel("2026-08-09T10:09:52.000Z", now)).toBe("8秒前");
  expect(scoreFreshnessLabel("2026-08-09T10:07:45.000Z", now)).toBe("2分钟15秒前");
  expect(scoreFreshnessLabel("2026-08-09T08:07:45.000Z", now)).toBe("2小时2分钟15秒前");
  expect(scoreFreshnessLabel(null, now)).toBe("尚无成功快照");
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
