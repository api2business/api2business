// 供应商标准成本使用原生 total_cost；account_stats_cost / actual_cost 可能包含
// Claude 等售卖倍率，只用于客户账务，不能作为上游消耗分母。
export function upstreamCostBasisSql(alias: string): string {
  return `COALESCE(${alias}.total_cost, 0)`;
}

/** 将 Sub2API 已含下游倍率的 actual_cost 折回供应商实际支出。 */
export function providerActualCostUsd(actualCostUsd: number, effectiveRate: number | null | undefined): number | null {
  return Number.isFinite(actualCostUsd) && actualCostUsd >= 0
    && effectiveRate !== null && effectiveRate !== undefined
    && Number.isFinite(effectiveRate) && effectiveRate > 0
    ? actualCostUsd * effectiveRate : null;
}
