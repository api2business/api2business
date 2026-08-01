type Row = Record<string, unknown>;

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function decimal(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

export interface DailyProfitLedgerInput {
  manualIncomeCny: number;
  manualExpenseCny: number;
  yamlIncomeCny: number;
  yamlCostCny: number;
  procurementRefundCny: number;
  upstreamRechargeCny: number;
  upstreamCapitalCny?: number;
  upstreamBalanceCnyPerApiUsd?: number;
  upstreamCapitalCoverage?: {
    rechargeWalletCount: number;
    capitalizedWalletCount: number;
    missingWallets: string[];
  };
  deferredCostRateCnyPerApiUsd: number;
  warnings?: string[];
}

export function buildDailyProfitReport(facts: Row, ledger: DailyProfitLedgerInput): Row {
  const alipay = facts.alipay as Row | undefined;
  const imports = facts.accountImportCosts as Row | undefined;
  const liability = facts.liability as Row | undefined;
  const alipayRevenueCny = money(number(alipay?.revenueCny));
  const accountImportCny = money(number(imports?.totalCostCny));
  const totalRevenueCny = money(alipayRevenueCny + ledger.manualIncomeCny + ledger.yamlIncomeCny);
  const grossDirectCostCny = money(accountImportCny + ledger.upstreamRechargeCny
    + ledger.manualExpenseCny + ledger.yamlCostCny);
  const cashDirectCostCny = money(grossDirectCostCny - ledger.procurementRefundCny);
  const upstreamCapitalCny = number(ledger.upstreamCapitalCny);
  const upstreamBalanceCnyPerApiUsd = number(ledger.upstreamBalanceCnyPerApiUsd) || 1;
  const consumedUpstreamCny = money(Math.max(0, ledger.upstreamRechargeCny - upstreamCapitalCny));
  const totalDirectCostCny = money(accountImportCny + consumedUpstreamCny
    + ledger.manualExpenseCny + ledger.yamlCostCny - ledger.procurementRefundCny);
  const cashGrossProfitCny = money(totalRevenueCny - cashDirectCostCny);
  const operatingGrossProfitCny = money(totalRevenueCny - totalDirectCostCny);
  const redeemableChangeUsd = decimal(number(liability?.redeemableChangeUsd));
  const deferredCostChangeCny = decimal(redeemableChangeUsd * ledger.deferredCostRateCnyPerApiUsd);
  const adjustedProfitCny = money(operatingGrossProfitCny - deferredCostChangeCny);
  return {
    ok: true,
    mode: "daily-profit",
    selector: facts.selector,
    window: facts.window,
    dayComplete: facts.dayComplete,
    asOf: facts.asOf,
    revenue: {
      alipayCny: alipayRevenueCny,
      manualCny: money(ledger.manualIncomeCny),
      yamlCny: money(ledger.yamlIncomeCny),
      totalCny: totalRevenueCny,
    },
    directCosts: {
      accountImportCny,
      upstreamRechargeCny: money(ledger.upstreamRechargeCny),
      upstreamCapitalCny: money(upstreamCapitalCny),
      upstreamConsumedCny: consumedUpstreamCny,
      manualExpenseCny: money(ledger.manualExpenseCny),
      yamlCostCny: money(ledger.yamlCostCny),
      procurementRefundCny: money(ledger.procurementRefundCny),
      grossCny: grossDirectCostCny,
      totalCny: totalDirectCostCny,
    },
    cashGrossProfitCny,
    operatingGrossProfitCny,
    capitalAdjusted: {
      upstreamBalanceCnyPerApiUsd,
      upstreamCapitalCny: money(upstreamCapitalCny),
      coverage: ledger.upstreamCapitalCoverage ?? {
        rechargeWalletCount: 0,
        capitalizedWalletCount: 0,
        missingWallets: [],
      },
      treatment: "remaining_upstream_balance_is_capital",
    },
    deferredCost: {
      openingRedeemableBalanceUsd: number((liability?.opening as Row | undefined)?.redeemableBalanceUsd),
      closingRedeemableBalanceUsd: number((liability?.closing as Row | undefined)?.redeemableBalanceUsd),
      redeemableChangeUsd,
      costRateCnyPerApiUsd: ledger.deferredCostRateCnyPerApiUsd,
      changeCny: deferredCostChangeCny,
      treatment: deferredCostChangeCny < 0 ? "release" : deferredCostChangeCny > 0 ? "accrual" : "unchanged",
    },
    adjustedProfitCny,
    replay: facts.replay,
    databaseQueries: facts.databaseQueries,
    queueDurationMs: facts.queueDurationMs,
    queryDurationMs: facts.queryDurationMs,
    warnings: ledger.warnings ?? [],
    valuesPrinted: false,
  };
}
