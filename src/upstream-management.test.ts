import { expect, test } from "bun:test";
import { buildRuntimeCreateArgs, findAccountId, formatRate, formatUpstreamName, normalizeBaseUrl, parseUpstreamName, validateCapacity, validateGroupIds, validatePriority, validateRate, validateSuffix } from "./upstream-management";

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

test("runtime upstream creation uses the controlled template without model mappings", () => {
  const args = buildRuntimeCreateArgs("NC01-DOCKER", {
    pageSize: 10,
    defaultTemplate: "codex-upstream-failover",
    primaryGroupId: 2,
    groupIds: [2, 3],
    priority: 1,
    capacity: 16,
    proxyId: 3,
  }, "https://api.example.com plus 0.05", "https://api.example.com");
  expect(args).toContain("--kind");
  expect(args[args.indexOf("--kind") + 1]).toBe("temp-unschedulable");
  expect(args).not.toContain("--model-mappings-json");
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

test("runtime upstream creation accepts explicit priority, capacity, and pool selection", () => {
  const args = buildRuntimeCreateArgs("NC01-DOCKER", {
    pageSize: 10,
    defaultTemplate: "codex-upstream-failover",
    primaryGroupId: 2,
    groupIds: [2, 3],
    priority: 1,
    capacity: 16,
    proxyId: 3,
  }, "https://api.example.com plus 0.05", "https://api.example.com", {
    priority: 12,
    capacity: 8,
    groupIds: [3],
  });
  expect(args[args.indexOf("--group") + 1]).toBe("3");
  expect(args[args.indexOf("--priority") + 1]).toBe("12");
  expect(args[args.indexOf("--capacity") + 1]).toBe("8");
  expect(validatePriority(1)).toBe(1);
  expect(validateCapacity(16)).toBe(16);
  expect(validateGroupIds([3, 2, 3])).toEqual([2, 3]);
  expect(() => validatePriority(0)).toThrow("初始优先级");
  expect(() => validateCapacity(0)).toThrow("并发容量");
  expect(() => validateGroupIds([])).toThrow("号池");
});
