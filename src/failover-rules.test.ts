import { expect, test } from "bun:test";
import { validateFailoverRules, type FailoverRule } from "./failover-rules";

function rule(errorCode: number, keywords: string[]): FailoverRule {
  return { error_code: errorCode, keywords, duration_minutes: 3, description: "test" };
}

test("preserves legacy failover keywords while rejecting model-not-found", () => {
  expect(() => validateFailoverRules([rule(503, [
    "please retry later",
    "service temporarily unavailable",
    "temporarily unavailable",
    "overloaded",
    "concurrency limit exceeded",
    "504",
  ])])).not.toThrow();
  expect(() => validateFailoverRules([rule(404, ["model_not_found"])] )).toThrow();
  expect(() => validateFailoverRules([rule(404, [
    'Model "gpt-5.6" is not supported by any configured account in this group',
  ])])).toThrow();
  expect(() => validateFailoverRules([rule(404, ["no available channel for model gpt-5.6"])]))
    .toThrow();
});

test("preserves the legacy upstream wrapper phrase", () => {
  expect(() => validateFailoverRules([rule(502, ["upstream request failed"])]))
    .not.toThrow();
  expect(() => validateFailoverRules([rule(503, ["upstream request failed"])]))
    .not.toThrow();
});

test("allows duplicate keywords accepted by the Sub2API native template", () => {
  expect(() => validateFailoverRules([
    rule(502, ["upstream service temporarily unavailable"]),
    rule(502, ["upstream service temporarily unavailable"]),
  ])).not.toThrow();
});

test("keeps model capacity and billing/authentication matches explicit", () => {
  expect(() => validateFailoverRules([
    rule(429, ["selected model is at capacity", "concurrency limit exceeded for account"]),
    rule(401, ["invalid_api_key", "authentication failed"]),
    rule(402, ["insufficient account balance"]),
    rule(403, ["invalid_api_key"]),
  ])).not.toThrow();
});
