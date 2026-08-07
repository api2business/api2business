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
});
