import { expect, test } from "bun:test";
import type { AppConfig } from "./config";
import { projectBugTeamCostSample } from "./bugteam-cost-monitor";

const monitor = {
  enabled: true,
  product: "team_1h",
  sampleIntervalSeconds: 60,
  expectedOutputApiUsd: 30,
  historyHours: 24,
} satisfies AppConfig["bugTeam"]["monitor"];

test("projects BugTeam inventory into per-account cost and fill rate", () => {
  const sample = projectBugTeamCostSample({
    available: 69,
    base_unit_price_fen: 360,
    billing_base_seconds: 3600,
    estimated_unit_price_fen: 178,
    minimum_remaining_seconds: 1783,
    maximum_remaining_seconds: 1800,
  }, monitor, "2026-08-16T12:00:00.000Z");

  expect(sample.status).toBe("ok");
  expect(sample.available).toBe(69);
  expect(sample.unitPriceCny).toBe(1.78);
  expect(sample.minimumUnitPriceCny).toBe(1.78);
  expect(sample.maximumUnitPriceCny).toBe(1.8);
  expect(sample.minimumExpectedCostCnyPerApiUsd).toBeCloseTo(1.78 / 30);
  expect(sample.maximumExpectedCostCnyPerApiUsd).toBeCloseTo(1.8 / 30);
  expect(sample.fillRateApiUsdPerHour).toBeCloseTo(30 * 3600 / 1783);
});

test("keeps empty inventory metrics nullable instead of inventing zeros", () => {
  const sample = projectBugTeamCostSample({ available: 0 }, monitor);
  expect(sample.status).toBe("empty");
  expect(sample.available).toBe(0);
  expect(sample.unitPriceCny).toBeNull();
  expect(sample.fillRateApiUsdPerHour).toBeNull();
});
