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

test("successful provider debt is authoritative; missing or failed balances are not", () => {
  for (const remaining of [-0.01, 0, 12]) expect(authoritativeUsageBalance({ ok: true,
    quota: { remaining, unit: "USD" } })).toBeTrue();
  for (const remaining of [null, undefined, "", NaN]) expect(authoritativeUsageBalance({ ok: true,
    quota: { remaining, unit: "USD" } })).toBeFalse();
  expect(authoritativeUsageBalance({ ok: false, quota: { remaining: -0.01, unit: "USD" } })).toBeFalse();
});

test("billing timeout and key unlimited never replace numeric wallet history", () => {
  for (const warning of [undefined, "New API 账号级 billing 查询失败：The operation timed out.", "AUTH_CAPTCHA_REQUIRED"]) {
    expect(authoritativeUsageBalance({ ok: true, provider: "new-api", warning,
      quota: { unit: null, remaining: null, unlimited: true } })).toBeFalse();
  }
});
