import { expect, test } from "bun:test";
import { buildRuntimeCreateArgs, findAccountId, formatRate, formatUpstreamName, normalizeBaseUrl, parseUpstreamName, validateRate, validateSuffix } from "./upstream-management";

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
