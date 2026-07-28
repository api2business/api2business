import { expect, test } from "bun:test";
import { jitteredIntervalSeconds } from "./priority-automation-schedule";

test("automation jitter stays within the configured ten-percent range", () => {
  expect(jitteredIntervalSeconds(600, 0.1, () => 0)).toBe(540);
  expect(jitteredIntervalSeconds(600, 0.1, () => 0.5)).toBe(600);
  expect(jitteredIntervalSeconds(600, 0.1, () => 1)).toBe(660);
});
