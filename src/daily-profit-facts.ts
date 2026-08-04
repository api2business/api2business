import { DateTime } from "luxon";
import type { AppConfig } from "./config";
import type { Sub2ApiReadClient, Sub2ApiReadPriority } from "./sub2api-read-executor";
import { parseAlipayRevenueWindow } from "./alipay-revenue-database";
import { summarizeAccountImportCosts } from "./account-import-cost-ledger";

type Row = Record<string, unknown>;

const dailyProfitFactsSql = `
WITH bounds AS (
  SELECT $1::timestamptz AS start_at, $2::timestamptz AS end_at
),
balance_events AS (
  SELECT user_id, created_at AS occurred_at, -actual_cost::numeric AS delta, 'usage'::text AS source
  FROM usage_logs
  WHERE created_at >= (SELECT start_at FROM bounds)
    AND COALESCE(billing_type, 0) = 0
  UNION ALL
  SELECT used_by AS user_id, used_at AS occurred_at, value::numeric AS delta, 'redeem'::text AS source
  FROM redeem_codes
  WHERE status = 'used'
    AND type IN ('balance', 'admin_balance')
    AND used_by IS NOT NULL
    AND used_at >= (SELECT start_at FROM bounds)
  UNION ALL
  SELECT user_id, created_at AS occurred_at, amount::numeric AS delta, 'affiliate'::text AS source
  FROM user_affiliate_ledger
  WHERE action = 'transfer'
    AND created_at >= (SELECT start_at FROM bounds)
  UNION ALL
  SELECT user_id, used_at AS occurred_at, bonus_amount::numeric AS delta, 'promo'::text AS source
  FROM promo_code_usages
  WHERE used_at >= (SELECT start_at FROM bounds)
  UNION ALL
  SELECT o.user_id,
         a.created_at AS occurred_at,
         -COALESCE(NULLIF((a.detail::jsonb ->> 'balanceDeducted'), '')::numeric, 0) AS delta,
         'refund'::text AS source
  FROM payment_audit_logs a
  JOIN payment_orders o ON o.id::text = a.order_id
  WHERE a.action = 'REFUND_SUCCESS'
    AND a.created_at >= (SELECT start_at FROM bounds)
),
event_totals AS (
  SELECT
    user_id,
    COALESCE(SUM(delta), 0)::numeric AS delta_after_start,
    COALESCE(SUM(delta) FILTER (WHERE occurred_at >= (SELECT end_at FROM bounds)), 0)::numeric AS delta_after_end
  FROM balance_events
  GROUP BY user_id
),
historical_users AS (
  SELECT
    u.id,
    CASE
      WHEN u.created_at < b.start_at AND (u.deleted_at IS NULL OR u.deleted_at >= b.start_at)
      THEN u.balance::numeric - COALESCE(e.delta_after_start, 0)
      ELSE NULL
    END AS opening_balance,
    CASE
      WHEN u.created_at < b.end_at AND (u.deleted_at IS NULL OR u.deleted_at >= b.end_at)
      THEN u.balance::numeric - COALESCE(e.delta_after_end, 0)
      ELSE NULL
    END AS closing_balance
  FROM users u
  CROSS JOIN bounds b
  LEFT JOIN event_totals e ON e.user_id = u.id
  WHERE LOWER(COALESCE(u.role, '')) <> 'admin'
    AND u.email <> 'monitor-user@sub2api.platform-infra.local'
    AND u.email NOT LIKE 'api2business-probe-%@sub2api.platform-infra.local'
),
liability AS (
  SELECT
    COUNT(*) FILTER (WHERE opening_balance IS NOT NULL)::int AS opening_users,
    COUNT(*) FILTER (WHERE opening_balance > 0)::int AS opening_positive_users,
    COALESCE(SUM(opening_balance) FILTER (WHERE opening_balance IS NOT NULL), 0)::numeric AS opening_signed_balance,
    COALESCE(SUM(GREATEST(opening_balance, 0)) FILTER (WHERE opening_balance IS NOT NULL), 0)::numeric AS opening_redeemable_balance,
    COALESCE(SUM(LEAST(opening_balance, 0)) FILTER (WHERE opening_balance IS NOT NULL), 0)::numeric AS opening_negative_balance,
    COUNT(*) FILTER (WHERE closing_balance IS NOT NULL)::int AS closing_users,
    COUNT(*) FILTER (WHERE closing_balance > 0)::int AS closing_positive_users,
    COALESCE(SUM(closing_balance) FILTER (WHERE closing_balance IS NOT NULL), 0)::numeric AS closing_signed_balance,
    COALESCE(SUM(GREATEST(closing_balance, 0)) FILTER (WHERE closing_balance IS NOT NULL), 0)::numeric AS closing_redeemable_balance,
    COALESCE(SUM(LEAST(closing_balance, 0)) FILTER (WHERE closing_balance IS NOT NULL), 0)::numeric AS closing_negative_balance
  FROM historical_users
),
event_counts AS (
  SELECT
    COUNT(*) FILTER (WHERE source = 'usage')::int AS usage_events,
    COUNT(*) FILTER (WHERE source = 'redeem')::int AS redeem_events,
    COUNT(*) FILTER (WHERE source = 'affiliate')::int AS affiliate_events,
    COUNT(*) FILTER (WHERE source = 'promo')::int AS promo_events,
    COUNT(*) FILTER (WHERE source = 'refund')::int AS refund_events
  FROM balance_events
),
refund_warnings AS (
  SELECT COUNT(*)::int AS rollback_failed_events
  FROM payment_audit_logs
  WHERE action = 'REFUND_ROLLBACK_FAILED'
    AND created_at >= (SELECT start_at FROM bounds)
),
alipay AS (
  SELECT
    COUNT(*)::int AS completed_orders,
    COALESCE(SUM(o.pay_amount), 0)::numeric AS revenue_cny
  FROM payment_orders o
  JOIN users u ON u.id = o.user_id
  CROSS JOIN bounds b
  WHERE LOWER(COALESCE(u.role, '')) <> 'admin'
    AND o.provider_key = 'alipay'
    AND o.payment_type = 'alipay'
    AND o.status = 'COMPLETED'
    AND COALESCE(o.paid_at, o.completed_at, o.created_at) >= b.start_at
    AND COALESCE(o.paid_at, o.completed_at, o.created_at) < b.end_at
)
SELECT liability.*, event_counts.*, refund_warnings.*, alipay.*
FROM liability
CROSS JOIN event_counts
CROSS JOIN refund_warnings
CROSS JOIN alipay
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

export function parseCompletedProfitDay(day: string, timezone: string, nowMillis = Date.now()) {
  const window = parseAlipayRevenueWindow({ day, period: null }, timezone);
  const startMillis = DateTime.fromISO(window.startUtc).toMillis();
  const endMillis = DateTime.fromISO(window.endUtc).toMillis();
  if (startMillis > nowMillis) throw new Error("--day cannot be in the future");
  if (endMillis <= nowMillis) return { ...window, complete: true, asOf: window.endUtc };
  const asOf = DateTime.fromMillis(nowMillis, { zone: "utc" });
  return {
    ...window,
    endUtc: asOf.toISO()!,
    endLocal: asOf.setZone(timezone).toISO()!,
    complete: false,
    asOf: asOf.toISO()!,
  };
}

export async function collectDailyProfitFacts(
  config: AppConfig,
  reads: Sub2ApiReadClient,
  day: string,
  priority: Sub2ApiReadPriority = "manual",
): Promise<Row> {
  const window = parseCompletedProfitDay(day, config.monitor.timezone);
  const startedAt = performance.now();
  const query = await reads.query<Row>({
    key: JSON.stringify(["profit.daily-facts", window.startUtc, window.endUtc]),
    kind: "profit.daily-facts",
    sql: dailyProfitFactsSql,
    parameters: [window.startUtc, window.endUtc],
    priority,
    cacheMode: "bypass-cache",
  });
  const row = query.rows[0] ?? {};
  const openingRedeemable = decimal(row.opening_redeemable_balance);
  const closingRedeemable = decimal(row.closing_redeemable_balance);
  const rollbackFailedEvents = integer(row.rollback_failed_events);
  const accountImportCosts = summarizeAccountImportCosts(config.operations.accountImportLedgerPath, { day });
  return {
    ok: true,
    mode: "daily-profit-facts-postgresql",
    selector: day,
    window,
    dayComplete: window.complete,
    asOf: window.asOf,
    alipay: {
      completedOrders: integer(row.completed_orders),
      revenueCny: Math.round(number(row.revenue_cny) * 100) / 100,
    },
    accountImportCosts,
    liability: {
      opening: {
        users: integer(row.opening_users),
        positiveUsers: integer(row.opening_positive_users),
        signedBalanceUsd: decimal(row.opening_signed_balance),
        redeemableBalanceUsd: openingRedeemable,
        negativeBalanceUsd: decimal(row.opening_negative_balance),
      },
      closing: {
        users: integer(row.closing_users),
        positiveUsers: integer(row.closing_positive_users),
        signedBalanceUsd: decimal(row.closing_signed_balance),
        redeemableBalanceUsd: closingRedeemable,
        negativeBalanceUsd: decimal(row.closing_negative_balance),
      },
      redeemableChangeUsd: decimal(closingRedeemable - openingRedeemable),
    },
    replay: {
      complete: rollbackFailedEvents === 0,
      eventCounts: {
        usage: integer(row.usage_events),
        redeem: integer(row.redeem_events),
        affiliate: integer(row.affiliate_events),
        promo: integer(row.promo_events),
        refund: integer(row.refund_events),
      },
      rollbackFailedEvents,
      sources: ["usage_logs", "redeem_codes", "user_affiliate_ledger", "promo_code_usages", "payment_audit_logs"],
      warnings: rollbackFailedEvents === 0 ? [] : ["refund rollback failures prevent complete historical balance replay"],
    },
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

export const dailyProfitFactsQuery = dailyProfitFactsSql;
