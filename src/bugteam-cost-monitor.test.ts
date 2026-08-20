import { expect, test } from "bun:test";
import type { AppConfig } from "./config";
import { projectBugTeamCostSample, repriceRetainedBugTeamCostSample } from "./bugteam-cost-monitor";

const monitor = {
  enabled: true,
  product: "team_1h",
  sampleIntervalSeconds: 60,
  expectedOutputApiUsd: 30,
  historyHours: 24,
} satisfies AppConfig["bugTeam"]["monitor"];

test("projects only the lowest-priced BugTeam train into per-account cost and fill rate", () => {
  const sample = projectBugTeamCostSample({
    buckets: [
      { bucket_start: "2026-08-17T01:20:00+08:00", available: 38, minimum_remaining_seconds: 1548 },
      { bucket_start: "2026-08-17T01:50:00+08:00", available: 250, minimum_remaining_seconds: 3396 },
    ],
  }, {
    base_unit_price_fen: 300,
    billing_base_seconds: 3600,
  }, monitor, "2026-08-16T12:00:00.000Z");

  expect(sample.status).toBe("ok");
  expect(sample.available).toBe(38);
  expect(sample.unitPriceCny).toBe(2);
  expect(sample.minimumUnitPriceCny).toBe(2);
  expect(sample.maximumUnitPriceCny).toBe(2);
  expect(sample.minimumRemainingSeconds).toBe(1548);
  expect(sample.maximumRemainingSeconds).toBe(1548);
  expect(sample.expectedCostCnyPerApiUsd).toBeCloseTo(2 / 30);
  expect(sample.minimumExpectedCostCnyPerApiUsd).toBeCloseTo(2 / 30);
  expect(sample.maximumExpectedCostCnyPerApiUsd).toBeCloseTo(2 / 30);
  expect(sample.fillRateApiUsdPerHour).toBeCloseTo(30 * 3600 / 1548);
});

test("ignores a sold-out cheaper train and keeps all metrics on the selected train", () => {
  const sample = projectBugTeamCostSample({
    buckets: [
      { bucket_start: "cheap", available: 0 },
      { bucket_start: "next", available: 12, minimum_remaining_seconds: 2400, maximum_remaining_seconds: 2500 },
    ],
  }, { base_unit_price_fen: 300, billing_base_seconds: 3600 }, monitor);

  expect(sample.available).toBe(12);
  expect(sample.unitPriceCny).toBe(3);
  expect(sample.minimumRemainingSeconds).toBe(2400);
  expect(sample.maximumRemainingSeconds).toBe(2400);
  expect(sample.fillRateApiUsdPerHour).toBe(45);
});

test("uses the Team one-hour price boundary at exactly 30 minutes", () => {
  const shelves = (remainingSeconds: number) => ({
    buckets: [{ bucket_start: "boundary", available: 1, minimum_remaining_seconds: remainingSeconds }],
  });
  const pricing = { base_unit_price_fen: 300, billing_base_seconds: 3600 };

  expect(projectBugTeamCostSample(shelves(1800), pricing, monitor).unitPriceCny).toBe(3);
  expect(projectBugTeamCostSample(shelves(1799), pricing, monitor).unitPriceCny).toBe(2);
});

test("keeps empty inventory metrics nullable instead of inventing zeros", () => {
  const sample = projectBugTeamCostSample({ buckets: [{ available: 0 }] }, {
    base_unit_price_fen: 300,
    billing_base_seconds: 3600,
  }, monitor);
  expect(sample.status).toBe("empty");
  expect(sample.available).toBe(0);
  expect(sample.unitPriceCny).toBeNull();
  expect(sample.fillRateApiUsdPerHour).toBeNull();
});

test("reprices retained empty-inventory metrics with the current expected output", () => {
  const retained = repriceRetainedBugTeamCostSample({
    sampledAt: "2026-08-17T01:00:00.000Z",
    product: "team_1h",
    status: "ok",
    available: 1,
    unitPriceCny: 2.41,
    minimumUnitPriceCny: 2.41,
    maximumUnitPriceCny: 2.41,
    minimumRemainingSeconds: 2892,
    maximumRemainingSeconds: 2892,
    expectedCostCnyPerApiUsd: 2.41 / 35,
    minimumExpectedCostCnyPerApiUsd: 2.41 / 35,
    maximumExpectedCostCnyPerApiUsd: 2.41 / 35,
    fillRateApiUsdPerHour: 35 * 3600 / 2892,
    errorSummary: null,
  }, { ...monitor, expectedOutputApiUsd: 28 });

  expect(retained.expectedCostCnyPerApiUsd).toBeCloseTo(2.41 / 28);
  expect(retained.minimumExpectedCostCnyPerApiUsd).toBeCloseTo(2.41 / 28);
  expect(retained.maximumExpectedCostCnyPerApiUsd).toBeCloseTo(2.41 / 28);
  expect(retained.fillRateApiUsdPerHour).toBeCloseTo(28 * 3600 / 2892);
});
