import { expect, test } from "bun:test";
import { buildDailyProfitReport } from "./daily-profit";

test("combines daily ledgers and releases deferred cost when liability falls", () => {
  const result = buildDailyProfitReport({
    selector: "2026-07-31",
    dayComplete: true,
    alipay: { revenueCny: 100 },
    accountImportCosts: { totalCostCny: 275.45 },
    liability: {
      opening: { redeemableBalanceUsd: 14402.29918452 },
      closing: { redeemableBalanceUsd: 14302.8240122 },
      redeemableChangeUsd: -99.47517232,
    },
    replay: { complete: true },
    databaseQueries: 1,
  }, {
    manualIncomeCny: 130,
    manualExpenseCny: 0,
    yamlIncomeCny: 0,
    yamlCostCny: 40,
    procurementRefundCny: 0,
    upstreamRechargeCny: 70,
    upstreamCapitalCny: 55,
    upstreamCapitalCoverage: { rechargeWalletCount: 3, capitalizedWalletCount: 2, missingWallets: ["https://missing.example"] },
    deferredCostRateCnyPerApiUsd: 0.08,
  });

  expect(result.revenue).toEqual({ alipayCny: 100, manualCny: 130, yamlCny: 0, totalCny: 230 });
  expect(result.directCosts).toMatchObject({ accountImportCny: 275.45, upstreamRechargeCny: 70, upstreamCapitalCny: 55, upstreamConsumedCny: 15, yamlCostCny: 40, totalCny: 330.45 });
  expect(result.cashGrossProfitCny).toBe(-155.45);
  expect(result.capitalAdjusted).toMatchObject({ coverage: { rechargeWalletCount: 3, capitalizedWalletCount: 2, missingWallets: ["https://missing.example"] } });
  expect(result.deferredCost).toMatchObject({ changeCny: -7.95801379, treatment: "release" });
  expect(result.adjustedProfitCny).toBe(-92.49);
  expect(result.databaseQueries).toBe(1);
});
