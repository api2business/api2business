import { DateTime } from "luxon";
import type { AppConfig } from "./config";
import type { Sub2ApiReadClient, Sub2ApiReadPriority } from "./sub2api-read-executor";
import type { ImpactWindow } from "./user-impact-database";
import { summarizeAccountImportCosts } from "./account-import-cost-ledger";

type Row = Record<string, unknown>;

const alipayRevenueSql = `
WITH completed_alipay_orders AS (
  SELECT
    o.pay_amount,
    COALESCE(o.paid_at, o.completed_at, o.created_at) AS paid_at
  FROM payment_orders o
  JOIN users u ON u.id = o.user_id
  WHERE LOWER(COALESCE(u.role, '')) <> 'admin'
    AND o.provider_key = 'alipay'
    AND o.payment_type = 'alipay'
    AND o.status = 'COMPLETED'
    AND COALESCE(o.paid_at, o.completed_at, o.created_at) >= $1::timestamptz
    AND COALESCE(o.paid_at, o.completed_at, o.created_at) < $2::timestamptz
)
SELECT
  COUNT(*)::int AS completed_orders,
  COALESCE(SUM(pay_amount), 0)::numeric AS revenue_cny,
  MIN(paid_at) AS first_paid_at,
  MAX(paid_at) AS last_paid_at
FROM completed_alipay_orders
`;

export interface AlipayRevenueWindowInput {
  day?: string | null;
  period?: string | null;
}

function window(start: DateTime, end: DateTime, timezone: string): ImpactWindow {
  return {
    startUtc: start.toUTC().toISO()!,
    endUtc: end.toUTC().toISO()!,
    startLocal: start.setZone(timezone).toISO()!,
    endLocal: end.setZone(timezone).toISO()!,
    timezone,
  };
}

export function parseAlipayRevenueWindow(
  input: AlipayRevenueWindowInput,
  timezone: string,
): ImpactWindow & { kind: "day" | "period"; selector: string } {
  const day = input.day?.trim() || null;
  const period = input.period?.trim() || null;
  if ((day === null) === (period === null)) {
    throw new Error("provide exactly one of --day or --period");
  }
  if (day !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error("--day must be YYYY-MM-DD");
    const start = DateTime.fromISO(day, { zone: timezone }).startOf("day");
    if (!start.isValid || start.toISODate() !== day) throw new Error("--day must be a valid calendar date");
    return { ...window(start, start.plus({ days: 1 }), timezone), kind: "day", selector: day };
  }
  if (!/^\d{4}-\d{2}$/u.test(period!)) throw new Error("--period must be YYYY-MM");
  const start = DateTime.fromFormat(period!, "yyyy-MM", { zone: timezone }).startOf("month");
  if (!start.isValid || start.toFormat("yyyy-MM") !== period) throw new Error("--period must be a valid calendar month");
  return { ...window(start, start.plus({ months: 1 }), timezone), kind: "period", selector: period! };
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function localTime(value: unknown, timezone: string): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date
    ? DateTime.fromJSDate(value)
    : DateTime.fromISO(String(value), { setZone: true });
  return parsed.isValid ? parsed.setZone(timezone).toISO() : null;
}

export async function collectAlipayRevenue(
  config: AppConfig,
  reads: Sub2ApiReadClient,
  input: AlipayRevenueWindowInput,
  priority: Sub2ApiReadPriority = "manual",
): Promise<Row> {
  const selectedWindow = parseAlipayRevenueWindow(input, config.monitor.timezone);
  const startedAt = performance.now();
  const query = await reads.query<Row>({
    key: JSON.stringify(["payments.alipay-revenue", selectedWindow.startUtc, selectedWindow.endUtc]),
    kind: "payments.alipay-revenue",
    sql: alipayRevenueSql,
    parameters: [selectedWindow.startUtc, selectedWindow.endUtc],
    priority,
    cacheMode: "prefer-cache",
  });
  const row = query.rows[0] ?? {};
  const accountImportCosts = summarizeAccountImportCosts(config.operations.accountImportLedgerPath,
    selectedWindow.kind === "day" ? { day: selectedWindow.selector } : { period: selectedWindow.selector });
  return {
    ok: true,
    mode: "alipay-revenue-postgresql",
    windowKind: selectedWindow.kind,
    selector: selectedWindow.selector,
    window: {
      startUtc: selectedWindow.startUtc,
      endUtc: selectedWindow.endUtc,
      startLocal: selectedWindow.startLocal,
      endLocal: selectedWindow.endLocal,
      timezone: selectedWindow.timezone,
    },
    completedOrders: number(row.completed_orders),
    revenueCny: Math.round(number(row.revenue_cny) * 100) / 100,
    accountImportCosts,
    firstPaidAt: localTime(row.first_paid_at, selectedWindow.timezone),
    lastPaidAt: localTime(row.last_paid_at, selectedWindow.timezone),
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

export const alipayRevenueQuery = alipayRevenueSql;
