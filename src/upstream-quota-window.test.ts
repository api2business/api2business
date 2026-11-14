import { describe, expect, test } from "bun:test";
import { exhaustedQuotaWindows, quotaWindowsExhausted } from "./upstream-quota-window";

describe("quota window exhaustion", () => {
  test("returns exhausted complete windows", () => {
    const usage = {
      quotaWindows: [
        { window: "five_hour", remainingPercent: 100, complete: true },
        { window: "weekly", remainingPercent: 0, complete: true },
        { window: "monthly", remainingPercent: 0, complete: true },
      ],
    };
    expect(exhaustedQuotaWindows(usage)).toEqual(["weekly", "monthly"]);
    expect(quotaWindowsExhausted(usage)).toBe(true);
  });

  test("ignores incomplete windows and missing usage", () => {
    expect(exhaustedQuotaWindows({
      quotaWindows: [{ window: "weekly", remainingPercent: 0, complete: false }],
    })).toEqual([]);
    expect(quotaWindowsExhausted(null)).toBe(false);
  });
});
