import type { Sub2ApiReadClient, Sub2ApiReadPriority } from "./sub2api-read-executor";

type Row = Record<string, unknown>;

const userBalanceLiabilitySql = `
SELECT
  COUNT(*)::int AS non_admin_users,
  COUNT(*) FILTER (WHERE u.balance > 0)::int AS positive_balance_users,
  COUNT(*) FILTER (WHERE u.balance = 0)::int AS zero_balance_users,
  COUNT(*) FILTER (WHERE u.balance < 0)::int AS negative_balance_users,
  COALESCE(SUM(u.balance), 0)::numeric AS signed_balance_usd,
  COALESCE(SUM(GREATEST(u.balance, 0)), 0)::numeric AS redeemable_balance_usd,
  COALESCE(SUM(LEAST(u.balance, 0)), 0)::numeric AS negative_balance_usd
FROM users u
WHERE u.deleted_at IS NULL
  AND LOWER(COALESCE(u.role, '')) <> 'admin'
  AND u.email <> 'monitor-user@sub2api.platform-infra.local'
  AND u.email NOT LIKE 'api2business-probe-%@sub2api.platform-infra.local'
`;

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integer(value: unknown): number {
  return Math.max(0, Math.trunc(number(value)));
}

function decimal(value: unknown): number {
  return Math.round(number(value) * 100_000_000) / 100_000_000;
}

export async function collectUserBalanceLiability(
  reads: Sub2ApiReadClient,
  priority: Sub2ApiReadPriority = "manual",
): Promise<Row> {
  const startedAt = performance.now();
  const query = await reads.query<Row>({
    key: "users.balance-liability.current",
    kind: "users.balance-liability",
    sql: userBalanceLiabilitySql,
    parameters: [],
    priority,
    cacheMode: "bypass-cache",
  });
  const row = query.rows[0] ?? {};
  return {
    ok: true,
    mode: "user-balance-liability-postgresql",
    nonAdminUserCount: integer(row.non_admin_users),
    positiveBalanceUserCount: integer(row.positive_balance_users),
    zeroBalanceUserCount: integer(row.zero_balance_users),
    negativeBalanceUserCount: integer(row.negative_balance_users),
    signedBalanceUsd: decimal(row.signed_balance_usd),
    redeemableBalanceUsd: decimal(row.redeemable_balance_usd),
    negativeBalanceUsd: decimal(row.negative_balance_usd),
    databaseQueries: query.cached ? 0 : 1,
    queueDurationMs: query.queueDurationMs,
    queryDurationMs: query.queryDurationMs,
    totalDurationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    queryStartedAt: query.queryStartedAt,
    queryCompletedAt: query.queryCompletedAt,
    deduplicated: query.deduplicated,
    cached: query.cached,
    valuesPrinted: false,
  };
}

export const userBalanceLiabilityQuery = userBalanceLiabilitySql;
