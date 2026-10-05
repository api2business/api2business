import { expect, test } from "bun:test";
import { quotaGroup, quotaMemberships } from "./quota-grouping.js";

test("classifies Claude Kiro before the generic Claude group", () => {
  expect(quotaGroup({ platform: "anthropic", groupNames: ["Claude Code Kiro 渠道"] })).toBe("claude-kiro");
  expect(quotaMemberships({ platform: "anthropic", groupNames: ["Claude Code Kiro 渠道", "【24H稳定】Claude MAX"] })).toEqual(
    new Set(["claude-kiro", "claude"]),
  );
});
