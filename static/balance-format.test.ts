import { expect, test } from "bun:test";
import { balanceNumber } from "./balance-format.js";

test("renders positive, zero, negative and unknown balances distinctly", () => {
  expect(balanceNumber(12)).toBe("12.00");
  expect(balanceNumber(0)).toBe("0.00");
  expect(balanceNumber(-12.5)).toBe("-12.50");
  expect(balanceNumber(-0.00203599)).toBe("-0.00203599");
  expect(balanceNumber(-0.0000000001)).toBe("-0.0000000001");
  for (const value of [null, undefined, NaN, Infinity]) expect(balanceNumber(value)).toBe("—");
});
