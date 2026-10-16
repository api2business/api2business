import { expect, test } from "bun:test";
import { quotaAvailabilityTotals } from "./quota-availability.js";

test("wallet net balance includes debts while available funds and pie weights stay positive", () => {
  const rows = [10, -2, 0, null].map(remaining => ({ remaining, availableGroups: ["codex-mix"] }));
  expect(quotaAvailabilityTotals(rows, "codex-mix")).toEqual({ total: 8, available: 10, unavailable: -2, ratio: 1 });
  expect(quotaAvailabilityTotals(rows.slice(1), "codex-mix")).toEqual({ total: -2, available: 0, unavailable: -2, ratio: 0 });
});
