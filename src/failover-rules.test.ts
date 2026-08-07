import { expect, test } from "bun:test";
import { validateFailoverRules, type FailoverRule } from "./failover-rules";

function rule(errorCode: number, keywords: string[]): FailoverRule {
  return { error_code: errorCode, keywords, duration_minutes: 3, description: "test" };
}

test("rejects generic failover keywords that cannot distinguish business errors", () => {
  for (const keyword of [
    "please retry later",
    "service temporarily unavailable",
    "temporarily unavailable",
    "overloaded",
    "concurrency limit exceeded",
    "model_not_found",
    "504",
  ]) {
    expect(() => validateFailoverRules([rule(503, [keyword])])).toThrow();
  }
});

test("allows the native upstream wrapper phrase only for transient gateway statuses", () => {
  expect(() => validateFailoverRules([rule(502, ["upstream request failed"])]))
    .not.toThrow();
  expect(() => validateFailoverRules([rule(503, ["upstream request failed"])]))
    .toThrow();
});

test("keeps model capacity and billing/authentication matches explicit", () => {
  expect(() => validateFailoverRules([
    rule(429, ["selected model is at capacity", "concurrency limit exceeded for account"]),
    rule(402, ["insufficient account balance"]),
    rule(403, ["invalid_api_key"]),
  ])).not.toThrow();
});
