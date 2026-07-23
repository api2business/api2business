import { SQL } from "bun";
import { DateTime } from "luxon";
import type { AppConfig } from "./config";
import { readSecret } from "./secrets";

type Row = Record<string, unknown>;

const userImpactSql = `
WITH successful_requests AS (
  SELECT
    user_id,
    COALESCE(request_id, 'usage:' || id::text) AS request_key,
    request_id,
    MIN(created_at) AS first_at,
    MAX(created_at) AS last_at,
    SUM(actual_cost)::numeric AS actual_cost,
    SUM(input_tokens + output_tokens)::bigint AS tokens
  FROM usage_logs
  WHERE created_at >= $1::timestamptz
    AND created_at < $2::timestamptz
    AND user_id IS NOT NULL
  GROUP BY user_id, COALESCE(request_id, 'usage:' || id::text), request_id
),
error_requests AS (
  SELECT
    user_id,
    COALESCE(request_id, 'error:' || id::text) AS request_key,
    request_id,
    MIN(created_at) AS first_at,
    MAX(created_at) AS last_at,
    BOOL_OR(
      COALESCE(is_business_limited, false) IS FALSE
      AND LOWER(COALESCE(error_phase, '')) NOT IN ('client', 'business')
      AND (
        COALESCE(status_code, 0) >= 500
        OR COALESCE(upstream_status_code, 0) >= 500
        OR LOWER(COALESCE(error_phase, '')) IN ('upstream', 'internal', 'network')
      )
    ) AS infrastructure_failure
  FROM ops_error_logs
  WHERE created_at >= $1::timestamptz
    AND created_at < $2::timestamptz
    AND user_id IS NOT NULL
  GROUP BY user_id, COALESCE(request_id, 'error:' || id::text), request_id
),
request_outcomes AS (
  SELECT
    COALESCE(s.user_id, e.user_id) AS user_id,
    s.request_key AS success_key,
    e.request_key AS error_key,
    e.infrastructure_failure,
    LEAST(
      COALESCE(s.first_at, 'infinity'::timestamptz),
      COALESCE(e.first_at, 'infinity'::timestamptz)
    ) AS first_at,
    GREATEST(
      COALESCE(s.last_at, '-infinity'::timestamptz),
      COALESCE(e.last_at, '-infinity'::timestamptz)
    ) AS last_at,
    COALESCE(s.actual_cost, 0)::numeric AS actual_cost,
    COALESCE(s.tokens, 0)::bigint AS tokens
  FROM successful_requests s
  FULL JOIN error_requests e
    ON s.user_id = e.user_id
   AND s.request_id IS NOT NULL
   AND s.request_id = e.request_id
),
user_totals AS (
  SELECT
    user_id,
    COUNT(*) FILTER (WHERE success_key IS NOT NULL)::int AS success_requests,
    COUNT(*) FILTER (WHERE error_key IS NOT NULL)::int AS error_requests,
    COUNT(*) FILTER (
      WHERE infrastructure_failure IS TRUE AND success_key IS NULL
    )::int AS customer_visible_infrastructure_failures,
    MIN(first_at) AS first_at,
    MAX(last_at) AS last_at,
    SUM(actual_cost)::numeric AS actual_cost,
    SUM(tokens)::bigint AS tokens
  FROM request_outcomes
  GROUP BY user_id
)
SELECT
  u.id AS user_id,
  u.username,
  u.email,
  u.status,
  t.success_requests,
  t.error_requests,
  t.customer_visible_infrastructure_failures,
  t.first_at,
  t.last_at,
  t.actual_cost,
  t.tokens
FROM user_totals t
JOIN users u ON u.id = t.user_id
WHERE u.deleted_at IS NULL
  AND LOWER(COALESCE(u.role, '')) <> 'admin'
ORDER BY
  t.customer_visible_infrastructure_failures DESC,
  t.success_requests DESC,
  u.id
`;

export interface ImpactWindow {
  startUtc: string;
  endUtc: string;
  startLocal: string;
  endLocal: string;
  timezone: string;
}

function parseBoundary(value: string, timezone: string, name: string): DateTime {
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
  const parsed = hasOffset
    ? DateTime.fromISO(value, { setZone: true })
    : DateTime.fromISO(value, { zone: timezone });
  if (!parsed.isValid) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return parsed;
}

export function parseImpactWindow(start: string, end: string, timezone: string): ImpactWindow {
  const startAt = parseBoundary(start, timezone, "--start");
  const endAt = parseBoundary(end, timezone, "--end");
  if (endAt.toMillis() <= startAt.toMillis()) throw new Error("--end must be later than --start");
  return {
    startUtc: startAt.toUTC().toISO()!,
    endUtc: endAt.toUTC().toISO()!,
    startLocal: startAt.setZone(timezone).toISO()!,
    endLocal: endAt.setZone(timezone).toISO()!,
    timezone,
  };
}

export function maskIdentity(value: unknown, email = false): string {
  const text = String(value ?? "").trim();
  if (!text) return "-";
  if (!email) return `${Array.from(text).slice(0, 3).join("")}***`;
  const at = text.indexOf("@");
  if (at < 1) return `${text.slice(0, 3)}***`;
  return `${text.slice(0, at).slice(0, 3)}***${text.slice(at)}`;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function projectRow(row: Row, timezone: string): Row {
  const successes = number(row.success_requests);
  const failures = number(row.customer_visible_infrastructure_failures);
  const attempts = successes + failures;
  const username = String(row.username ?? "").trim();
  const email = String(row.email ?? "").trim();
  return {
    userId: String(row.user_id),
    displayNameMasked: maskIdentity(username || email.split("@", 1)[0]),
    emailMasked: maskIdentity(email, true),
    status: row.status,
    successRequests: successes,
    errorRequests: number(row.error_requests),
    customerVisibleInfrastructureFailures: failures,
    failureRate: attempts > 0 ? Math.round(failures / attempts * 1_000_000) / 1_000_000 : null,
    affected: failures > 0,
    actualCostUsd: number(row.actual_cost),
    tokens: number(row.tokens),
    firstActiveAt: DateTime.fromJSDate(row.first_at as Date).setZone(timezone).toISO(),
    lastActiveAt: DateTime.fromJSDate(row.last_at as Date).setZone(timezone).toISO(),
  };
}

export async function collectUserImpactFromDatabase(
  config: AppConfig,
  start: string,
  end: string,
  affectedOnly = false,
  databaseUrlOverride: string | null = null,
): Promise<Row> {
  const window = parseImpactWindow(start, end, config.monitor.timezone);
  const databaseUrl = databaseUrlOverride ?? readSecret(config, config.sub2api.scoreDatabase);
  const database = new SQL(databaseUrl, { max: 1 });
  const startedAt = performance.now();
  let queryDurationMs = 0;
  try {
    const rows = await database.begin(async (transaction) => {
      await transaction.unsafe("SET TRANSACTION READ ONLY");
      await transaction.unsafe(`SET LOCAL statement_timeout = '${config.sub2api.scoreDatabase.statementTimeoutMs}ms'`);
      const queryStartedAt = performance.now();
      const result = await transaction.unsafe(userImpactSql, [window.startUtc, window.endUtc]);
      queryDurationMs = Math.round((performance.now() - queryStartedAt) * 10) / 10;
      return result;
    }) as unknown as Row[];
    const projected = rows.map((row) => projectRow(row, window.timezone));
    const users = affectedOnly ? projected.filter((row) => row.affected === true) : projected;
    return {
      ok: true,
      mode: "user-impact-postgresql",
      window,
      affectedOnly,
      userCount: users.length,
      activeUserCount: projected.length,
      affectedUserCount: projected.filter((row) => row.affected === true).length,
      databaseQueries: 1,
      queryDurationMs,
      totalDurationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      users,
      valuesPrinted: false,
    };
  } finally {
    await database.close();
  }
}

export const userImpactQuery = userImpactSql;
