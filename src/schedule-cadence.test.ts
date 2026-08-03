import { expect, test } from "bun:test";
import { remainingScheduleDelayMs } from "./schedule-cadence";

test("keeps a fixed cadence after success or timeout", () => {
  expect(remainingScheduleDelayMs(300_000, 120_000)).toBe(180_000);
  expect(remainingScheduleDelayMs(300_000, 240_000)).toBe(60_000);
  expect(remainingScheduleDelayMs(300_000, 310_000)).toBe(0);
});
