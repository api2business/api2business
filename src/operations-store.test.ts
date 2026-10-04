import { expect, test } from "bun:test";
import { authoritativeUsageBalance, postgresBigintArrayLiteral } from "./operations-store";

test("encodes account IDs as a PostgreSQL bigint array literal", () => {
  expect(postgresBigintArrayLiteral([49, 330, 307])).toBe("{49,330,307}");
  expect(() => postgresBigintArrayLiteral([0])).toThrow("positive integers");
});

test("does not replace a wallet balance with New API key-only unlimited quota", () => {
  expect(authoritativeUsageBalance({
    ok: true,
    provider: "new-api",
    quota: { unlimited: true, remaining: null, unit: null },
    warning: "New API 只返回 API Key 配额；缺少可证明账号钱包余额的 Dashboard/PAT 凭据",
  })).toBe(false);
  expect(authoritativeUsageBalance({
    ok: true,
    provider: "new-api",
    quota: { unlimited: false, remaining: 29.3, unit: "USD" },
  })).toBe(true);
});
