import { expect, test } from "bun:test";
import {
  buildOAuthRuntimeSample,
  oauthRuntimeHistory,
  summarizeOAuthRuntimeSamples,
  type OAuthRuntimeSample,
} from "./oauth-runtime-monitor";

test("builds OAuth runtime samples from current pool economics without rolling cost", () => {
  const sample = buildOAuthRuntimeSample({
    pool: { total: { apiAmountUsd: 80, expectedApiAmountUsd: 120, remainingExpectedApiAmountUsd: 40 } },
    health: { accountCount: 4, normalCount: 2, rateLimitedCount: 1, errorCount: 1 },
  }, "codex", "2026-08-02T01:00:00Z");
  expect(sample).toMatchObject({ profile: "codex", apiAmountUsdTotal: 80, remainingExpectedApiAmountUsd: 40, accountCount: 4 });
  expect(sample).not.toHaveProperty("costCny");
});

test("calculates rolling OAuth API consumption and expected remaining lifetime", () => {
  const base: OAuthRuntimeSample = {
    sampledAt: "2026-08-02T01:00:00Z", profile: "codex", apiAmountUsdTotal: 80,
    expectedApiAmountUsd: 120, remainingExpectedApiAmountUsd: 40,
    accountCount: 4, normalCount: 2, rateLimitedCount: 1, errorCount: 1,
  };
  const samples = [base, { ...base, sampledAt: "2026-08-02T02:00:00Z", apiAmountUsdTotal: 90, remainingExpectedApiAmountUsd: 30 }];
  const summary = summarizeOAuthRuntimeSamples(samples);
  expect(summary.consumedApiAmountUsd).toBe(10);
  expect(summary.apiAmountUsdPerHour).toBe(10);
  expect(summary.estimatedAvailableHours).toBe(3);
  expect(oauthRuntimeHistory(samples).at(-1)).toMatchObject({ consumedApiAmountUsd: 10, remainingExpectedApiAmountUsd: 30 });
});

test("calculates adjacent-sample and one-hour rolling speeds on the same timeline", () => {
  const base: OAuthRuntimeSample = {
    sampledAt: "2026-08-02T01:00:00Z", profile: "codex", apiAmountUsdTotal: 80,
    expectedApiAmountUsd: 160, remainingExpectedApiAmountUsd: 80,
    accountCount: 4, normalCount: 4, rateLimitedCount: 0, errorCount: 0,
  };
  const history = oauthRuntimeHistory([
    base,
    { ...base, sampledAt: "2026-08-02T01:05:00Z", apiAmountUsdTotal: 90 },
    { ...base, sampledAt: "2026-08-02T01:10:00Z", apiAmountUsdTotal: 95 },
  ]);
  expect(history[0]?.sampleApiAmountUsdPerHour).toBeNull();
  expect(history[1]?.sampleApiAmountUsdPerHour).toBeCloseTo(120);
  expect(history[2]?.sampleApiAmountUsdPerHour).toBeCloseTo(60);
  expect(history[2]?.rollingApiAmountUsdPerHour).toBeCloseTo(90);
});

test("folds burst samples into the configured sampling interval instead of hourly spike amplification", () => {
  const base: OAuthRuntimeSample = {
    sampledAt: "2026-08-02T01:00:00Z", profile: "codex", apiAmountUsdTotal: 80,
    expectedApiAmountUsd: 160, remainingExpectedApiAmountUsd: 80,
    accountCount: 4, normalCount: 4, rateLimitedCount: 0, errorCount: 0,
  };
  const history = oauthRuntimeHistory([
    base,
    { ...base, sampledAt: "2026-08-02T01:05:00Z", apiAmountUsdTotal: 90 },
    { ...base, sampledAt: "2026-08-02T01:05:10Z", apiAmountUsdTotal: 91 },
    { ...base, sampledAt: "2026-08-02T01:05:20Z", apiAmountUsdTotal: 92 },
  ], 1, 8, 300);
  expect(history[1]?.sampleApiAmountUsdPerHour).toBeCloseTo(120);
  expect(history[2]?.sampleApiAmountUsdPerHour).toBeCloseTo(127.742, 3);
  expect(history[3]?.sampleApiAmountUsdPerHour).toBeCloseTo(135, 3);
  expect(history[3]?.rollingApiAmountUsdPerHour).toBeCloseTo(135, 3);
});

test("leaves burst speed unknown until a full configured sampling interval exists", () => {
  const base: OAuthRuntimeSample = {
    sampledAt: "2026-08-02T01:00:00Z", profile: "codex", apiAmountUsdTotal: 80,
    expectedApiAmountUsd: 160, remainingExpectedApiAmountUsd: 80,
    accountCount: 4, normalCount: 4, rateLimitedCount: 0, errorCount: 0,
  };
  const history = oauthRuntimeHistory([
    base,
    { ...base, sampledAt: "2026-08-02T01:00:10Z", apiAmountUsdTotal: 81 },
  ], 1, 8, 300);
  expect(history[1]?.sampleApiAmountUsdPerHour).toBeNull();
  expect(history[1]?.rollingApiAmountUsdPerHour).toBeCloseTo(360);
});

test("falls back to a stable rolling rate immediately after the pool baseline changes", () => {
  const base: OAuthRuntimeSample = {
    sampledAt: "2026-08-02T01:00:00Z", profile: "codex", apiAmountUsdTotal: 80,
    expectedApiAmountUsd: 160, remainingExpectedApiAmountUsd: 80,
    accountCount: 4, normalCount: 4, rateLimitedCount: 0, errorCount: 0,
  };
  const history = oauthRuntimeHistory([
    base,
    { ...base, sampledAt: "2026-08-02T01:05:00Z", apiAmountUsdTotal: 90 },
    { ...base, sampledAt: "2026-08-02T01:05:10Z", apiAmountUsdTotal: 90, accountCount: 5 },
  ], 1, 8, 300);
  expect(history[2]?.sampleApiAmountUsdPerHour).toBeCloseTo(120);
  expect(history[2]?.rollingApiAmountUsdPerHour).toBeCloseTo(120);
});

test("clamps a cumulative output rollback to zero sample speed", () => {
  const base: OAuthRuntimeSample = {
    sampledAt: "2026-08-02T01:00:00Z", profile: "codex", apiAmountUsdTotal: 80,
    expectedApiAmountUsd: 160, remainingExpectedApiAmountUsd: 80,
    accountCount: 4, normalCount: 4, rateLimitedCount: 0, errorCount: 0,
  };
  const history = oauthRuntimeHistory([base, { ...base, sampledAt: "2026-08-02T01:05:00Z", apiAmountUsdTotal: 70 }]);
  expect(history[1]?.sampleApiAmountUsdPerHour).toBe(0);
});

test("keeps rolling speed after a cumulative reset caused by account retirement", () => {
  const base: OAuthRuntimeSample = {
    sampledAt: "2026-08-02T01:00:00Z", profile: "codex", apiAmountUsdTotal: 100,
    expectedApiAmountUsd: 160, remainingExpectedApiAmountUsd: 60,
    accountCount: 10, normalCount: 10, rateLimitedCount: 0, errorCount: 0,
  };
  const summary = summarizeOAuthRuntimeSamples([
    base,
    { ...base, sampledAt: "2026-08-02T01:20:00Z", apiAmountUsdTotal: 110 },
    { ...base, sampledAt: "2026-08-02T01:40:00Z", apiAmountUsdTotal: 70, accountCount: 8 },
    { ...base, sampledAt: "2026-08-02T02:00:00Z", apiAmountUsdTotal: 80, accountCount: 8 },
  ]);
  expect(summary.consumedApiAmountUsd).toBe(20);
  expect(summary.apiAmountUsdPerHour).toBeCloseTo(30);
  expect(summary.warning).toContain("号池基线变化");
});

test("distinguishes a measured zero rate from missing samples", () => {
  const base: OAuthRuntimeSample = {
    sampledAt: "2026-08-02T01:00:00Z", profile: "codex", apiAmountUsdTotal: 100,
    expectedApiAmountUsd: 160, remainingExpectedApiAmountUsd: 60,
    accountCount: 10, normalCount: 10, rateLimitedCount: 0, errorCount: 0,
  };
  const summary = summarizeOAuthRuntimeSamples([
    base,
    { ...base, sampledAt: "2026-08-02T02:00:00Z" },
  ]);
  expect(summary.consumedApiAmountUsd).toBe(0);
  expect(summary.apiAmountUsdPerHour).toBe(0);
  expect(summary.warning).toContain("没有 API 消耗");
});

test("missing intermediate samples does not change the rolling result", () => {
  const base: OAuthRuntimeSample = {
    sampledAt: "2026-08-02T01:00:00Z", profile: "codex", apiAmountUsdTotal: 80,
    expectedApiAmountUsd: 160, remainingExpectedApiAmountUsd: 80,
    accountCount: 4, normalCount: 4, rateLimitedCount: 0, errorCount: 0,
  };
  const full = [
    base,
    { ...base, sampledAt: "2026-08-02T01:20:00Z", apiAmountUsdTotal: 90 },
    { ...base, sampledAt: "2026-08-02T01:40:00Z", apiAmountUsdTotal: 100 },
    { ...base, sampledAt: "2026-08-02T02:00:00Z", apiAmountUsdTotal: 110 },
  ];
  const sparse = [full[0]!, full[3]!];
  expect(summarizeOAuthRuntimeSamples(full).apiAmountUsdPerHour).toBeCloseTo(30);
  expect(summarizeOAuthRuntimeSamples(sparse).apiAmountUsdPerHour).toBeCloseTo(30);
});

test("reports zero remaining lifetime when realtime expected output is exhausted", () => {
  const sample: OAuthRuntimeSample = {
    sampledAt: "2026-08-02T02:00:00Z", profile: "grok", apiAmountUsdTotal: 32,
    expectedApiAmountUsd: 25, remainingExpectedApiAmountUsd: 0,
    accountCount: 24, normalCount: 18, rateLimitedCount: 5, errorCount: 1,
  };
  expect(summarizeOAuthRuntimeSamples([sample]).estimatedAvailableHours).toBe(0);
});

test("limits chart history to eight hours without changing the one-hour rolling calculation", () => {
  const base: OAuthRuntimeSample = {
    sampledAt: "2026-08-02T00:00:00Z", profile: "codex", apiAmountUsdTotal: 0,
    expectedApiAmountUsd: 200, remainingExpectedApiAmountUsd: 200,
    accountCount: 4, normalCount: 4, rateLimitedCount: 0, errorCount: 0,
  };
  const samples = Array.from({ length: 19 }, (_, index) => ({
    ...base,
    sampledAt: new Date(Date.parse(base.sampledAt) + index * 30 * 60_000).toISOString(),
    apiAmountUsdTotal: index * 5,
    remainingExpectedApiAmountUsd: 200 - index * 5,
  }));
  const history = oauthRuntimeHistory(samples, 1, 8);
  expect(history).toHaveLength(17);
  expect(history[0]?.sampledAt).toBe("2026-08-02T01:00:00.000Z");
  expect(history[0]?.rollingApiAmountUsdPerHour).toBe(10);
  expect(history.at(-1)?.sampledAt).toBe("2026-08-02T09:00:00.000Z");
});
