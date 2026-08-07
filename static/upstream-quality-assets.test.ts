import { expect, test } from "bun:test";
import { buildSupplierQualityAssets, normalizeSupplierWallet } from "./upstream-quality-assets.js";

test("normalizes supplier wallets consistently with quota accounting", () => {
  expect(normalizeSupplierWallet("https://a.test/v1/")).toBe("https://a.test");
  expect(normalizeSupplierWallet("https://a.test/")).toBe("https://a.test");
});

test("weights supplier quality by balance and keeps the good threshold strict", () => {
  const result = buildSupplierQualityAssets({
    walletDistribution: [
      { wallet: "https://a.test", remainingCny: 60, remainingUsd: 60, schedulable: true },
      { wallet: "https://b.test", remainingCny: 30, remainingUsd: 30, schedulable: true },
      { wallet: "https://c.test", remainingCny: 10, remainingUsd: 10, schedulable: true },
    ],
    upstreamAccounts: [
      { id: 1, baseUrl: "https://a.test/v1" },
      { id: 2, baseUrl: "https://a.test" },
      { id: 3, baseUrl: "https://b.test" },
    ],
    scoreRows: [
      { accountId: 1, score: 90 },
      { accountId: 2, score: 80 },
      { accountId: 3, score: 80 },
    ],
    consumedCny: 20,
    burnWindowHours: 2,
  });

  expect(result.totalBalanceCny).toBe(100);
  expect(result.goodBalanceCny).toBe(60);
  expect(result.goodBalanceRatio).toBe(0.6);
  expect(result.estimatedGoodAvailableHours).toBe(6);
  expect(result.items.find((row) => row.wallet === "https://a.test")).toMatchObject({ score: 85, good: true, ratio: 0.6 });
  expect(result.items.find((row) => row.wallet === "https://b.test")).toMatchObject({ score: 80, good: false, ratio: 0.3 });
  expect(result.unknownScoreWallets).toBe(1);
  expect(result.qualityBands).toEqual([
    { band: "good", remainingCny: 60, ratio: 0.6, supplierCount: 1 },
    { band: "mid", remainingCny: 30, ratio: 0.3, supplierCount: 1 },
    { band: "risk", remainingCny: 10, ratio: 0.1, supplierCount: 1 },
  ]);
});

test("excludes unschedulable suppliers from good available balance", () => {
  const result = buildSupplierQualityAssets({
    walletDistribution: [{ wallet: "https://a.test", remainingCny: 20, schedulable: false }],
    upstreamAccounts: [{ id: 1, baseUrl: "https://a.test" }],
    scoreRows: [{ accountId: 1, score: 99 }],
    consumedCny: 2,
    burnWindowHours: 1,
  });
  expect(result.goodBalanceCny).toBe(0);
  expect(result.goodBalanceRatio).toBe(0);
  expect(result.estimatedGoodAvailableHours).toBeNull();
  expect(result.qualityBands).toEqual([
    { band: "good", remainingCny: 0, ratio: 0, supplierCount: 0 },
    { band: "mid", remainingCny: 0, ratio: 0, supplierCount: 0 },
    { band: "risk", remainingCny: 20, ratio: 1, supplierCount: 1 },
  ]);
});

test("aggregates suppliers into one continuous segment per quality band", () => {
  const result = buildSupplierQualityAssets({
    walletDistribution: [
      { wallet: "https://good-a.test", remainingCny: 20, schedulable: true },
      { wallet: "https://good-b.test", remainingCny: 30, schedulable: true },
      { wallet: "https://mid-a.test", remainingCny: 15, schedulable: true },
      { wallet: "https://low.test", remainingCny: 10, schedulable: true },
      { wallet: "https://unknown.test", remainingCny: 5, schedulable: true },
      { wallet: "https://disabled.test", remainingCny: 20, schedulable: false },
    ],
    upstreamAccounts: [
      { id: 1, baseUrl: "https://good-a.test" },
      { id: 2, baseUrl: "https://good-b.test" },
      { id: 3, baseUrl: "https://mid-a.test" },
      { id: 4, baseUrl: "https://low.test" },
      { id: 5, baseUrl: "https://disabled.test" },
    ],
    scoreRows: [
      { accountId: 1, score: 81 },
      { accountId: 2, score: 95 },
      { accountId: 3, score: 60 },
      { accountId: 4, score: 59 },
      { accountId: 5, score: 99 },
    ],
  });

  expect(result.goodBalanceCny).toBe(50);
  expect(result.qualityBands).toEqual([
    { band: "good", remainingCny: 50, ratio: 0.5, supplierCount: 2 },
    { band: "mid", remainingCny: 15, ratio: 0.15, supplierCount: 1 },
    { band: "risk", remainingCny: 35, ratio: 0.35, supplierCount: 3 },
  ]);
});
