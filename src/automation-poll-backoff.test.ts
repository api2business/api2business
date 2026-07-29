import { expect, test } from "bun:test";
import { automationPollDelayMs } from "./automation-poll-backoff";

test("automation polling backs off after failures and remains bounded", () => {
  expect(automationPollDelayMs(1000, 60000, 0)).toBe(1000);
  expect(automationPollDelayMs(1000, 60000, 1)).toBe(1000);
  expect(automationPollDelayMs(1000, 60000, 2)).toBe(2000);
  expect(automationPollDelayMs(1000, 60000, 6)).toBe(32000);
  expect(automationPollDelayMs(1000, 60000, 20)).toBe(60000);
});
