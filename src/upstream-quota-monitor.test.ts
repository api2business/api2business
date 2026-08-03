import { expect, test } from "bun:test";
import { buildQuotaSamples, quotaHistory, summarizeQuotaSamples } from "./upstream-quota-monitor";

test("deduplicates shared wallets and preserves schedulability", () => {
  const samples = buildQuotaSamples([
    { accountId: 1, baseUrl: "https://a.test/v1", ok: true, status: "active", schedulable: false, provider: "sub2api", quota: { unit: "USD", remaining: 10 } },
    { accountId: 2, baseUrl: "https://a.test", ok: true, status: "active", schedulable: true, provider: "sub2api", quota: { unit: "USD", remaining: 10 } },
  ], "2026-08-02T00:00:00Z", () => 1);
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ remainingCny: 10, schedulable: true });
});

test("computes wallet burn and rolling realtime cost without recharge offsets", () => {
  const base = { accountId: 1, status: "active", provider: "sub2api", probeOk: true, cnyPerUsd: 1, sourceQueriedAt: null };
  const summary = summarizeQuotaSamples([
    { ...base, walletKey: "a", sampledAt: "2026-08-02T00:00:00Z", schedulable: true, remainingUsd: 10, remainingCny: 10, apiAmountUsdTotal: 100 },
    { ...base, walletKey: "b", sampledAt: "2026-08-02T00:00:00Z", schedulable: false, remainingUsd: 5, remainingCny: 5, apiAmountUsdTotal: 100 },
    { ...base, walletKey: "a", sampledAt: "2026-08-02T01:00:00Z", schedulable: true, remainingUsd: 8, remainingCny: 8, apiAmountUsdTotal: 110 },
    { ...base, walletKey: "b", sampledAt: "2026-08-02T01:00:00Z", schedulable: false, remainingUsd: 9, remainingCny: 9, apiAmountUsdTotal: 110 },
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
    { ...base, sampledAt: "2026-08-02T01:00:00Z", apiAmountUsdTotal: 100 },
    { ...base, sampledAt: "2026-08-02T01:05:00Z", apiAmountUsdTotal: 110 },
    { ...base, sampledAt: "2026-08-02T01:15:00Z", apiAmountUsdTotal: 105 },
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
    sourceQueriedAt: sampledAt, apiAmountUsdTotal,
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
