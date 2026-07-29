import { expect, test } from "bun:test";
import { automationPollDelayMs } from "./automation-poll-backoff";

test("automation polling backs off after failures and remains bounded", () => {
  expect(automationPollDelayMs(1000, 60000, 0)).toBe(1000);
  expect(automationPollDelayMs(1000, 60000, 1)).toBe(1000);
  expect(automationPollDelayMs(1000, 60000, 2)).toBe(2000);
  expect(automationPollDelayMs(1000, 60000, 6)).toBe(32000);
  expect(automationPollDelayMs(1000, 60000, 20)).toBe(60000);
});

test("automation polling stops rapid retries after the declared limit", () => {
  expect(automationPollDelayMs(1000, 60000, 1, 3, 1800000)).toBe(1000);
  expect(automationPollDelayMs(1000, 60000, 2, 3, 1800000)).toBe(2000);
  expect(automationPollDelayMs(1000, 60000, 3, 3, 1800000)).toBe(4000);
  expect(automationPollDelayMs(1000, 60000, 4, 3, 1800000)).toBe(1800000);
  expect(automationPollDelayMs(1000, 60000, 100, 3, 1800000)).toBe(1800000);
});
