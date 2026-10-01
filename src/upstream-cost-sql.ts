// 原生账号统计价格优先；没有预计算价格时按原生账号倍率回退。
// 不使用客户 actual_cost，人民币费率由上游资产换算统一应用。
export function upstreamCostBasisSql(alias: string): string {
  return `COALESCE(${alias}.account_stats_cost, ${alias}.total_cost * COALESCE(${alias}.account_rate_multiplier, 1))`;
}
