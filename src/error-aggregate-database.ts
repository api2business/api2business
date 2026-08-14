import type { AppConfig } from "./config";
import type {
  Sub2ApiReadClient,
  Sub2ApiReadPriority,
} from "./sub2api-read-executor";

type Row = Record<string, unknown>;

const errorAggregateSql = `
WITH internal_probe_keys AS (
  SELECT k.id
  FROM api_keys k
  LEFT JOIN users owner ON owner.id = k.user_id
  WHERE owner.email = 'monitor-user@sub2api.platform-infra.local'
    OR LOWER(COALESCE(k.name, '')) LIKE 'api2business-probe-%'
), target_accounts AS (
  SELECT a.id, a.name
  FROM accounts a
  WHERE a.deleted_at IS NULL
    AND ($2::text IS NULL OR a.id::text = $2::text OR a.name = $2::text)
), request_groups AS (
  SELECT g.id, g.name
  FROM groups g
  WHERE $3::text IS NULL OR g.id::text = $3::text OR g.name = $3::text
),
selected_errors AS (
  SELECT
    o.id,
    o.request_id,
    o.account_id,
    o.status_code,
    o.upstream_status_code,
    o.error_phase,
    o.error_type,
    o.error_message,
    o.network_error_type,
    o.is_business_limited,
    o.stream,
    o.created_at,
    o.requested_model,
    o.model,
    a.name AS account_name,
    COALESCE(o.request_id, 'error:' || o.id::text) AS request_key
  FROM ops_error_logs o
  LEFT JOIN target_accounts a ON a.id = o.account_id
  LEFT JOIN request_groups request_group ON request_group.id = o.group_id
  WHERE ($2::text IS NULL OR a.id IS NOT NULL)
    AND ($3::text IS NULL OR request_group.id IS NOT NULL)
    AND LOWER(COALESCE(request_group.name, '')) NOT LIKE 'api2business-probe-%'
    AND NOT EXISTS (
      SELECT 1 FROM internal_probe_keys probe WHERE probe.id = o.api_key_id
    )
    AND NOT (COALESCE(o.status_code, o.upstream_status_code, 0) BETWEEN 200 AND 399)
  ORDER BY o.created_at DESC, o.id DESC
  LIMIT $1
),
classified_errors AS (
  SELECT
    e.*,
    EXISTS (
      SELECT 1
      FROM usage_logs u
      WHERE e.request_id IS NOT NULL
        AND u.request_id = e.request_id
    ) AS recovered,
    CASE
      WHEN COALESCE(e.is_business_limited, false)
        OR LOWER(COALESCE(e.error_phase, '')) = 'business' THEN 'business_limit'
      WHEN LOWER(COALESCE(e.error_phase, '')) = 'client' THEN 'client_input'
      WHEN e.status_code = 429 OR e.upstream_status_code = 429 THEN 'rate_limit'
      WHEN e.status_code IN (502, 503, 504, 524)
        OR e.upstream_status_code IN (502, 503, 504, 524)
        THEN 'gateway_unavailable'
      WHEN LOWER(COALESCE(e.network_error_type, '')) LIKE '%timeout%'
        OR LOWER(COALESCE(e.error_type, '')) LIKE '%timeout%'
        OR LOWER(COALESCE(e.error_message, '')) LIKE '%timed out%'
        OR LOWER(COALESCE(e.error_message, '')) LIKE '%deadline exceeded%' THEN 'timeout'
      WHEN LOWER(COALESCE(e.error_message, '')) LIKE '%usage limit%'
        OR LOWER(COALESCE(e.error_message, '')) LIKE '%weekly limit%' THEN 'usage_limit'
      WHEN LOWER(COALESCE(e.error_message, '')) LIKE '%model%not found%'
        OR LOWER(COALESCE(e.error_message, '')) LIKE '%unsupported%model%'
        OR LOWER(COALESCE(e.error_message, '')) LIKE '%no available channel for model%'
        THEN 'model_routing'
      WHEN COALESCE(e.status_code, 0) IN (401, 403)
        OR LOWER(COALESCE(e.error_phase, '')) = 'auth' THEN 'authentication'
      WHEN LOWER(COALESCE(e.error_message, '')) LIKE '%stream%disconnect%'
        OR LOWER(COALESCE(e.error_type, '')) LIKE '%stream%' THEN 'stream_interrupted'
      WHEN LOWER(COALESCE(e.error_phase, '')) = 'upstream'
        OR LOWER(COALESCE(e.error_type, '')) LIKE '%upstream%' THEN 'upstream_other'
      WHEN LOWER(COALESCE(e.error_phase, '')) IN ('internal', 'network') THEN 'infrastructure_other'
      ELSE 'other'
    END AS error_family
  FROM selected_errors e
),
request_facts AS (
  SELECT
    request_key,
    BOOL_OR(recovered) AS recovered,
    BOOL_OR(stream) AS stream,
    MIN(created_at) AS first_at,
    MAX(created_at) AS last_at,
    (ARRAY_AGG(account_id ORDER BY created_at DESC, id DESC))[1] AS account_id,
    (ARRAY_AGG(COALESCE(account_name, 'unattributed') ORDER BY created_at DESC, id DESC))[1] AS account_name,
    (ARRAY_AGG(COALESCE(status_code, upstream_status_code, 0) ORDER BY created_at DESC, id DESC))[1] AS status_code,
    (ARRAY_AGG(COALESCE(error_phase, 'unknown') ORDER BY created_at DESC, id DESC))[1] AS error_phase,
    (ARRAY_AGG(error_family ORDER BY created_at DESC, id DESC))[1] AS error_family,
    (ARRAY_AGG(COALESCE(requested_model, model, 'unknown') ORDER BY created_at DESC, id DESC))[1] AS model
  FROM classified_errors
  GROUP BY request_key
),
dimension_rows AS (
  SELECT 'account'::text AS dimension, COALESCE(account_id::text, '-') AS key,
    account_name AS label, COUNT(*)::int AS requests,
    COUNT(*) FILTER (WHERE NOT recovered)::int AS customer_visible,
    COUNT(*) FILTER (WHERE recovered)::int AS recovered
  FROM request_facts GROUP BY account_id, account_name
  UNION ALL
  SELECT 'status', status_code::text, status_code::text, COUNT(*)::int,
    COUNT(*) FILTER (WHERE NOT recovered)::int, COUNT(*) FILTER (WHERE recovered)::int
  FROM request_facts GROUP BY status_code
  UNION ALL
  SELECT 'phase', error_phase, error_phase, COUNT(*)::int,
    COUNT(*) FILTER (WHERE NOT recovered)::int, COUNT(*) FILTER (WHERE recovered)::int
  FROM request_facts GROUP BY error_phase
  UNION ALL
  SELECT 'family', error_family, error_family, COUNT(*)::int,
    COUNT(*) FILTER (WHERE NOT recovered)::int, COUNT(*) FILTER (WHERE recovered)::int
  FROM request_facts GROUP BY error_family
  UNION ALL
  SELECT 'model', model, model, COUNT(*)::int,
    COUNT(*) FILTER (WHERE NOT recovered)::int, COUNT(*) FILTER (WHERE recovered)::int
  FROM request_facts GROUP BY model
),
ranked_dimensions AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY dimension ORDER BY customer_visible DESC, requests DESC, key
  ) AS rank
  FROM dimension_rows
)
SELECT
  (SELECT COUNT(*)::int FROM selected_errors) AS sampled_error_rows,
  (SELECT COUNT(*)::int FROM request_facts) AS distinct_requests,
  (SELECT COUNT(*) FILTER (WHERE NOT recovered)::int FROM request_facts) AS customer_visible_requests,
  (SELECT COUNT(*) FILTER (WHERE recovered)::int FROM request_facts) AS recovered_requests,
  (SELECT COUNT(*) FILTER (WHERE stream)::int FROM request_facts) AS stream_requests,
  (SELECT MIN(first_at) FROM request_facts) AS first_at,
  (SELECT MAX(last_at) FROM request_facts) AS last_at,
  COALESCE((
    SELECT JSONB_OBJECT_AGG(dimension, rows)
    FROM (
      SELECT dimension, JSONB_AGG(
        JSONB_BUILD_OBJECT(
          'key', key,
          'label', label,
          'requests', requests,
          'customerVisible', customer_visible,
          'recovered', recovered
        ) ORDER BY customer_visible DESC, requests DESC, key
      ) AS rows
      FROM ranked_dimensions
      WHERE rank <= $4
      GROUP BY dimension
    ) limited
  ), '{}'::jsonb) AS dimensions
`;

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestamp(value: unknown, timezone: string): string | null {
  if (!(value instanceof Date)) return null;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value).replace(" ", "T");
}

export function projectErrorAggregateRow(row: Row, timezone: string): Row {
  return {
    sampledErrorRows: integer(row.sampled_error_rows),
    distinctRequests: integer(row.distinct_requests),
    customerVisibleRequests: integer(row.customer_visible_requests),
    recoveredRequests: integer(row.recovered_requests),
    streamRequests: integer(row.stream_requests),
    firstAt: timestamp(row.first_at, timezone),
    lastAt: timestamp(row.last_at, timezone),
    dimensions: row.dimensions ?? {},
  };
}

export async function collectErrorAggregateFromDatabase(
  config: AppConfig,
  reads: Sub2ApiReadClient,
  limit: number,
  top: number,
  accountSelector: string | null = null,
  groupSelector: string | null = null,
  priority: Sub2ApiReadPriority = "manual",
): Promise<Row> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    throw new Error("error aggregate limit must be an integer from 1 to 10000");
  }
  if (!Number.isInteger(top) || top < 1 || top > 100) {
    throw new Error("error aggregate top must be an integer from 1 to 100");
  }
  const startedAt = performance.now();
  const query = await reads.query<Row>({
    key: JSON.stringify([
      "errors.aggregate",
      limit,
      top,
      accountSelector,
      groupSelector,
    ]),
    kind: "errors.aggregate",
    sql: errorAggregateSql,
    parameters: [limit, accountSelector, groupSelector, top],
    priority,
    cacheMode: "prefer-cache",
  });
  const rows = query.rows;
    if (accountSelector !== null && integer(rows[0]?.sampled_error_rows) === 0) {
      throw new Error(`account selector resolved no recent errors: ${accountSelector}`);
    }
    if (groupSelector !== null && integer(rows[0]?.sampled_error_rows) === 0) {
      throw new Error(`group selector resolved no recent errors: ${groupSelector}`);
    }
  return {
      ok: true,
      mode: "error-aggregate-postgresql",
      limit,
      top,
      accountSelector,
      groupSelector,
      groupFilterBasis: "request-group",
      probeNoiseExcluded: true,
      timezone: config.monitor.timezone,
      databaseQueries: query.cached ? 0 : 1,
      queueDurationMs: query.queueDurationMs,
      queryDurationMs: query.queryDurationMs,
      totalDurationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      queryStartedAt: query.queryStartedAt,
      queryCompletedAt: query.queryCompletedAt,
      deduplicated: query.deduplicated,
      cached: query.cached,
      ...projectErrorAggregateRow(rows[0] ?? {}, config.monitor.timezone),
      valuesPrinted: false,
  };
}

export const errorAggregateQuery = errorAggregateSql;
