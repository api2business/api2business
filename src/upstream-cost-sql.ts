// 原生账号统计价格优先；没有预计算价格时按原生账号倍率回退。
// 不使用客户 actual_cost，人民币费率由上游资产换算统一应用。
export function upstreamCostBasisSql(alias: string): string {
  return `COALESCE(${alias}.account_stats_cost, ${alias}.total_cost * COALESCE(${alias}.account_rate_multiplier, 1))`;
}

export function excludeInternalProbeSql(usageAlias: string): string {
  return `NOT EXISTS (
    SELECT 1
    FROM api_keys probe_key
    JOIN users probe_user ON probe_user.id = probe_key.user_id
    WHERE probe_key.id = ${usageAlias}.api_key_id
      AND (
        probe_user.email = 'monitor-user@sub2api.platform-infra.local'
        OR LOWER(COALESCE(probe_key.name, '')) LIKE 'api2business-probe-%'
        OR LOWER(COALESCE(probe_user.email, '')) LIKE 'api2business-probe-%@sub2api.platform-infra.local'
      )
      AND probe_user.deleted_at IS NULL
      AND probe_key.deleted_at IS NULL
  )`;
}
