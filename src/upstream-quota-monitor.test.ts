import { expect, test } from "bun:test";
import { buildQuotaSamples, quotaHistory, summarizeQuotaSamples } from "./upstream-quota-monitor";

test("deduplicates shared wallets and preserves schedulability", () => {
  const samples = buildQuotaSamples([
    { accountId: 1, baseUrl: "https://a.test/v1", ok: true, status: "active", schedulable: false, provider: "sub2api", quota: { unit: "USD", remaining: 10 }, apiAmountUsdTotal: 4 },
    { accountId: 2, baseUrl: "https://a.test", ok: true, status: "active", schedulable: true, provider: "sub2api", quota: { unit: "USD", remaining: 10 }, apiAmountUsdTotal: 6 },
  ], "2026-08-02T00:00:00Z", () => 1);
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ remainingCny: 10, schedulable: true, walletApiAmountUsdTotal: 10 });
});

test("computes wallet burn and rolling realtime cost without recharge offsets", () => {
  const base = { accountId: 1, status: "active", provider: "sub2api", probeOk: true, cnyPerUsd: 1, sourceQueriedAt: null };
  const summary = summarizeQuotaSamples([
    { ...base, walletKey: "a", sampledAt: "2026-08-02T00:00:00Z", schedulable: true, remainingUsd: 10, remainingCny: 10, apiAmountUsdTotal: 100, walletApiAmountUsdTotal: 60 },
    { ...base, walletKey: "b", sampledAt: "2026-08-02T00:00:00Z", schedulable: false, remainingUsd: 5, remainingCny: 5, apiAmountUsdTotal: 100, walletApiAmountUsdTotal: 40 },
    { ...base, walletKey: "a", sampledAt: "2026-08-02T01:00:00Z", schedulable: true, remainingUsd: 8, remainingCny: 8, apiAmountUsdTotal: 110, walletApiAmountUsdTotal: 70 },
    { ...base, walletKey: "b", sampledAt: "2026-08-02T01:00:00Z", schedulable: false, remainingUsd: 9, remainingCny: 9, apiAmountUsdTotal: 110, walletApiAmountUsdTotal: 40 },
  ]);
  expect(summary).toMatchObject({ totalRemainingCny: 17, schedulableRemainingCny: 8, consumedCny: 2, apiAmountUsd: 10, realtimeCostCnyPerApiUsd: 0.2, burnWindowHours: 1, estimatedAvailableHours: 4 });
  expect(summary.walletDistribution).toEqual([
    { wallet: "a", remainingCny: 8, remainingUsd: 8, schedulable: true, ratio: 0.470588 },
    { wallet: "b", remainingCny: 9, remainingUsd: 9, schedulable: false, ratio: 0.529412 },
  ].sort((left, right) => right.remainingCny - left.remainingCny));
});

test("keeps burn and cost unknown with one point", () => {
  const summary = summarizeQuotaSamples([{ sampledAt: "2026-08-02T01:00:00Z", walletKey: "a", accountId: 1, schedulable: true, status: "active", provider: "sub2api", probeOk: true, remainingUsd: 8, cnyPerUsd: 1, remainingCny: 8, sourceQueriedAt: null, apiAmountUsdTotal: 110 }]);
  expect(summary.consumedCny).toBeNull();
  expect(summary.realtimeCostCnyPerApiUsd).toBeNull();
});

test("returns the last eight hours while retaining boundary calculation context", () => {
  const base = { walletKey: "a", accountId: 1, schedulable: true, status: "active", provider: "sub2api", probeOk: true, cnyPerUsd: 1, sourceQueriedAt: null };
  const samples = Array.from({ length: 19 }, (_, index) => ({
    ...base,
    sampledAt: new Date(Date.parse("2026-08-02T00:00:00Z") + index * 30 * 60_000).toISOString(),
    remainingUsd: 30 - index,
    remainingCny: 30 - index,
    apiAmountUsdTotal: 100 + index * 5,
    walletApiAmountUsdTotal: 100 + index * 5,
  }));
  const history = quotaHistory(samples, 1, 8);
  expect(history).toHaveLength(17);
  expect(history[0]!.sampledAt).toBe("2026-08-02T01:00:00.000Z");
  expect(history[0]!.sampleApiAmountUsdPerHour).toBe(10);
  expect(history.at(-1)).toMatchObject({
    sampledAt: "2026-08-02T09:00:00.000Z",
    totalRemainingCny: 12,
    apiAmountUsd: 10,
    sampleApiAmountUsdPerHour: 10,
    sampleRealtimeCostCnyPerApiUsd: 0.2,
    rollingApiAmountUsdPerHour: 10,
    realtimeCostCnyPerApiUsd: 0.2,
  });
});

test("uses actual sample intervals and clamps upstream API output rollback", () => {
  const base = { walletKey: "a", accountId: 1, schedulable: true, status: "active", provider: "sub2api", probeOk: true, remainingUsd: 20, cnyPerUsd: 1, remainingCny: 20, sourceQueriedAt: null };
  const history = quotaHistory([
    { ...base, sampledAt: "2026-08-02T01:00:00Z", apiAmountUsdTotal: 100, walletApiAmountUsdTotal: 100 },
    { ...base, sampledAt: "2026-08-02T01:05:00Z", apiAmountUsdTotal: 110, walletApiAmountUsdTotal: 110 },
    { ...base, sampledAt: "2026-08-02T01:15:00Z", apiAmountUsdTotal: 105, walletApiAmountUsdTotal: 105 },
  ]);
  expect(history[1]!.sampleApiAmountUsdPerHour).toBeCloseTo(120);
  expect(history[1]!.sampleRealtimeCostCnyPerApiUsd).toBeNull();
  expect(history[2]!.sampleApiAmountUsdPerHour).toBe(0);
  expect(history[2]!.rollingApiAmountUsdPerHour).toBeCloseTo(20);
});

test("missing intermediate samples preserves rolling burn and cost", () => {
  const base = {
    walletKey: "wallet", accountId: 1, schedulable: true, status: "active",
    provider: "sub2api", probeOk: true, cnyPerUsd: 1,
  };
  const sample = (sampledAt: string, remainingCny: number, apiAmountUsdTotal: number) => ({
    ...base, sampledAt, remainingUsd: remainingCny, remainingCny,
    sourceQueriedAt: sampledAt, apiAmountUsdTotal, walletApiAmountUsdTotal: apiAmountUsdTotal,
  });
  const full = [
    sample("2026-08-02T01:00:00Z", 100, 20),
    sample("2026-08-02T01:20:00Z", 98, 40),
    sample("2026-08-02T01:40:00Z", 96, 60),
    sample("2026-08-02T02:00:00Z", 94, 80),
  ];
  const sparse = [full[0]!, full[3]!];
  expect(summarizeQuotaSamples(full).consumedCny).toBe(6);
  expect(summarizeQuotaSamples(sparse).consumedCny).toBe(6);
  expect(summarizeQuotaSamples(full).realtimeCostCnyPerApiUsd).toBeCloseTo(0.1);
  expect(summarizeQuotaSamples(sparse).realtimeCostCnyPerApiUsd).toBeCloseTo(0.1);
});

test("recovers cost after unchanged balance samples by pairing from the last balance change", () => {
  const base = {
    walletKey: "wallet", accountId: 1, schedulable: true, status: "active",
    provider: "sub2api", probeOk: true, cnyPerUsd: 1, sourceQueriedAt: null,
  };
  const samples = [
    { ...base, sampledAt: "2026-08-02T00:00:00Z", remainingUsd: 10, remainingCny: 10, apiAmountUsdTotal: 100, walletApiAmountUsdTotal: 100 },
    { ...base, sampledAt: "2026-08-02T01:10:00Z", remainingUsd: 10, remainingCny: 10, apiAmountUsdTotal: 110, walletApiAmountUsdTotal: 110 },
    { ...base, sampledAt: "2026-08-02T01:20:00Z", remainingUsd: 9, remainingCny: 9, apiAmountUsdTotal: 120, walletApiAmountUsdTotal: 120 },
  ];
  const summary = summarizeQuotaSamples(samples);
  expect(summary.sampleRealtimeCostCnyPerApiUsd).toBeCloseTo(0.05);
  expect(summary.realtimeCostCnyPerApiUsd).toBeCloseTo(0.05);
  expect(summary.costApiAmountUsd).toBe(20);
});

test("excludes output from wallets without balance evidence from realtime cost", () => {
  const base = {
    accountId: 1, schedulable: true, status: "active", provider: "sub2api",
    probeOk: true, cnyPerUsd: 1, sourceQueriedAt: null,
  };
  const summary = summarizeQuotaSamples([
    { ...base, walletKey: "known", sampledAt: "2026-08-02T00:00:00Z", remainingUsd: 10, remainingCny: 10, apiAmountUsdTotal: 1000, walletApiAmountUsdTotal: 100 },
    { ...base, walletKey: "unknown", sampledAt: "2026-08-02T00:00:00Z", remainingUsd: null, remainingCny: null, apiAmountUsdTotal: 1000, walletApiAmountUsdTotal: 900 },
    { ...base, walletKey: "known", sampledAt: "2026-08-02T01:00:00Z", remainingUsd: 9, remainingCny: 9, apiAmountUsdTotal: 1110, walletApiAmountUsdTotal: 110 },
    { ...base, walletKey: "unknown", sampledAt: "2026-08-02T01:00:00Z", remainingUsd: null, remainingCny: null, apiAmountUsdTotal: 1110, walletApiAmountUsdTotal: 1000 },
  ]);
  expect(summary.apiAmountUsd).toBe(110);
  expect(summary.costApiAmountUsd).toBe(10);
  expect(summary.realtimeCostCnyPerApiUsd).toBeCloseTo(0.1);
});
