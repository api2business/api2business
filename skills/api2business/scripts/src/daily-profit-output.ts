function row(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cny(value: unknown): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "-";
  return `${parsed < 0 ? "-" : ""}¥${Math.abs(parsed).toFixed(2)}`;
}

function decimal(value: unknown, places = 6): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(places) : "-";
}

export function emitDailyProfit(value: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  const revenue = row(value.revenue);
  const costs = row(value.directCosts);
  const deferred = row(value.deferredCost);
  const capital = row(value.capitalAdjusted);
  const coverage = row(capital.coverage);
  const replay = row(value.replay);
  console.log(`API2BUSINESS DAILY PROFIT day=${String(value.selector)} complete=${String(value.dayComplete)} asOf=${String(value.asOf)} databaseQueries=${String(value.databaseQueries)}`);
  console.log(`REVENUE alipay=${cny(revenue.alipayCny)} manual=${cny(revenue.manualCny)} yaml=${cny(revenue.yamlCny)} total=${cny(revenue.totalCny)}`);
  console.log(`DIRECT_COST accountImport=${cny(costs.accountImportCny)} upstreamRecharge=${cny(costs.upstreamRechargeCny)} upstreamCapital=${cny(costs.upstreamCapitalCny)} upstreamConsumed=${cny(costs.upstreamConsumedCny)} manual=${cny(costs.manualExpenseCny)} yaml=${cny(costs.yamlCostCny)} procurementRefund=${cny(costs.procurementRefundCny)} total=${cny(costs.totalCny)}`);
  console.log(`CASH_GROSS_PROFIT ${cny(value.cashGrossProfitCny)}`);
  console.log(`OPERATING_GROSS_PROFIT ${cny(value.operatingGrossProfitCny)} upstreamBalanceCnyPerApiUsd=${decimal(capital.upstreamBalanceCnyPerApiUsd)} capitalCoverage=${String(coverage.capitalizedWalletCount ?? 0)}/${String(coverage.rechargeWalletCount ?? 0)}`);
  console.log(`DEFERRED_COST openingApiUsd=${decimal(deferred.openingRedeemableBalanceUsd)} closingApiUsd=${decimal(deferred.closingRedeemableBalanceUsd)} changeApiUsd=${decimal(deferred.redeemableChangeUsd)} rateCnyPerApiUsd=${decimal(deferred.costRateCnyPerApiUsd)} changeCny=${cny(deferred.changeCny)} treatment=${String(deferred.treatment)}`);
  console.log(`ADJUSTED_PROFIT ${cny(value.adjustedProfitCny)}`);
  console.log(`REPLAY complete=${String(replay.complete)} rollbackFailedEvents=${String(replay.rollbackFailedEvents ?? 0)}`);
  for (const warning of Array.isArray(value.warnings) ? value.warnings : []) console.log(`WARNING ${String(warning)}`);
}
