import { expect, test } from "bun:test";
import { quotaGroup, quotaMemberships, walletQuotaMemberships } from "./quota-grouping.js";

test("classifies Claude Kiro before the generic Claude group", () => {
  expect(quotaGroup({ platform: "anthropic", groupNames: ["Claude Code Kiro 渠道"] })).toBe("claude-kiro");
  expect(quotaMemberships({ platform: "anthropic", groupNames: ["Claude Code Kiro 渠道", "【24H稳定】Claude MAX"] })).toEqual(
    new Set(["claude-kiro", "claude"]),
  );
});

test("a shared wallet keeps Kiro membership alongside its existing Codex and MAX accounts", () => {
  const groups = [...new Set([
    "GPT Pro/Plus混池", "【正规】Claude MAX",
    "Claude Code Kiro 渠道", "api2business-probe-1522",
  ])];
  expect(quotaMemberships({ platform: "openai", groups }).has("claude-kiro")).toBeTrue();
  expect(walletQuotaMemberships([
    { platform: "openai", groupNames: ["GPT Pro/Plus混池"] },
    { platform: "anthropic", groupNames: ["【正规】Claude MAX"] },
    { platform: "anthropic", groupNames: ["Claude Code Kiro 渠道", "api2business-probe-1522"] },
  ])).toEqual(new Set(["codex-mix", "claude", "claude-kiro"]));
});
