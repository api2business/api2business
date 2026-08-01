import { expect, test } from "bun:test";
import { findAccountId, formatRate, formatUpstreamName, normalizeBaseUrl, parseUpstreamName, validateCapacity, validateGroupIds, validatePriority, validateRate, validateSuffix } from "./upstream-management";

test("upstream names preserve historical six-decimal rates", () => {
  expect(normalizeBaseUrl("https://api.example.com/")).toBe("https://api.example.com");
  expect(formatRate(0.045)).toBe("0.045");
  expect(formatUpstreamName("https://api.example.com/", "plus", 0.045)).toBe("https://api.example.com plus 0.045");
  expect(parseUpstreamName("https://api.example.com plus 0.045", "https://api.example.com")).toEqual({
    suffix: "plus",
    rateCnyPerApiUsd: 0.045,
  });
});

test("upstream inputs reject unsafe URLs, suffixes, and rates", () => {
  expect(() => normalizeBaseUrl("http://api.example.com")).toThrow("HTTPS URL");
  expect(() => normalizeBaseUrl("https://user:pass@api.example.com")).toThrow("HTTPS URL");
  expect(() => validateSuffix("plus space")).toThrow("后缀");
  expect(() => validateRate(0.0000001)).toThrow("6 位小数");
});

test("runtime mutation results can expose the account ID inside items", () => {
  expect(findAccountId({
    ok: true,
    operation: "create",
    items: [{ accountId: 123, actual: { accountId: 456 } }],
  })).toBe(123);
});

test("runtime mutation results accept account-shaped and nested data IDs", () => {
  expect(findAccountId({ ok: true, account: { id: 307 } })).toBe(307);
  expect(findAccountId({ ok: true, data: { account: { account_id: "308" } } })).toBe(308);
});

test("runtime upstream settings validate priority, capacity, and pool selection", () => {
  expect(validatePriority(1)).toBe(1);
  expect(validateCapacity(16)).toBe(16);
  expect(validateGroupIds([3, 2, 3])).toEqual([2, 3]);
  expect(() => validatePriority(0)).toThrow("初始优先级");
  expect(() => validateCapacity(0)).toThrow("并发容量");
  expect(() => validateGroupIds([])).toThrow("号池");
});

test("failover template uses the Sub2API native error_code schema", async () => {
  const config = await Bun.file(new URL("../config/sub2rank.yaml", import.meta.url)).text();
  expect(config).toContain("errorCode: 502");
  expect(config).toContain("errorCode: 524");
  expect(config).not.toContain("statusCode:");
});
