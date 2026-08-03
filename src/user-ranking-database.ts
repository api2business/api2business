import type { Sub2ApiReadClient, Sub2ApiReadPriority } from "./sub2api-read-executor";

type Row = Record<string, unknown>;

const userRankingSql = `
WITH usage AS (
  SELECT
    l.user_id,
    COALESCE(SUM(l.actual_cost), 0)::numeric AS actual_cost,
    COUNT(DISTINCT COALESCE(l.request_id, 'usage:' || l.id::text))::int AS requests,
    COALESCE(SUM(l.input_tokens + l.output_tokens), 0)::bigint AS tokens
  FROM usage_logs l
  WHERE l.created_at >= $1::timestamptz
    AND l.created_at < $2::timestamptz
    AND l.user_id IS NOT NULL
  GROUP BY l.user_id
), recharges AS (
  SELECT
    o.user_id,
    COALESCE(SUM(o.pay_amount), 0)::numeric AS recharge_cny
  FROM payment_orders o
  WHERE o.status = 'COMPLETED'
    AND COALESCE(o.paid_at, o.completed_at, o.created_at) >= $3::timestamptz
    AND COALESCE(o.paid_at, o.completed_at, o.created_at) < $2::timestamptz
  GROUP BY o.user_id
)
SELECT
  u.id AS user_id,
  u.username,
  u.email,
  u.role,
  u.status,
  u.balance,
  usage.actual_cost,
  usage.requests,
  usage.tokens,
  COALESCE(recharges.recharge_cny, 0)::numeric AS recharge_cny
FROM usage
JOIN users u ON u.id = usage.user_id
LEFT JOIN recharges ON recharges.user_id = u.id
WHERE u.deleted_at IS NULL
  AND LOWER(COALESCE(u.role, '')) <> 'admin'
ORDER BY usage.actual_cost DESC, u.id
LIMIT $4::int
`;

export async function collectUserRanking(
  reads: Sub2ApiReadClient,
  startUtc: string,
  endUtc: string,
  todayStartUtc: string,
  limit: number,
  priority: Sub2ApiReadPriority = "manual",
) {
  return await reads.query<Row>({
    key: JSON.stringify(["users.daily-ranking", startUtc, endUtc, todayStartUtc, limit]),
    kind: "users.daily-ranking",
    sql: userRankingSql,
    parameters: [startUtc, endUtc, todayStartUtc, limit],
    priority,
    cacheMode: "bypass-cache",
  });
}

export const userRankingQuery = userRankingSql;
