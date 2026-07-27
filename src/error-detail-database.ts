import { SQL } from "bun";
import type { AppConfig } from "./config";
import { readSecret } from "./secrets";

type Row = Record<string, unknown>;

const stablePhraseSql = `
JSONB_BUILD_OBJECT(
  'selectedModelAtCapacity', LOWER(message_text) LIKE '%selected model is at capacity%',
  'insufficientBalance', LOWER(message_text) LIKE '%insufficient account balance%',
  'modelNotFound', LOWER(message_text) LIKE '%model_not_found%',
  'noAvailableChannel', LOWER(message_text) LIKE '%no available channel for model%',
  'upstreamRequestFailed', LOWER(message_text) LIKE '%upstream request failed%'
)`;

const baseProjectionSql = `
WITH enriched AS (
  SELECT
    o.*,
    a.name AS account_name,
    u.email AS user_email,
    k.name AS api_key_name,
    k.deleted_at IS NOT NULL AS api_key_deleted,
    g.name AS group_name,
    COALESCE(o.error_message, '') || ' ' ||
      COALESCE(o.error_body, '') || ' ' ||
      COALESCE(o.upstream_error_message, '') || ' ' ||
      COALESCE(o.upstream_error_detail, '') AS message_text,
    EXISTS (
      SELECT 1 FROM usage_logs success
      WHERE success.request_id = o.request_id
    ) AS recovered
  FROM ops_error_logs o
  LEFT JOIN accounts a ON a.id = o.account_id
  LEFT JOIN api_keys k ON k.id = o.api_key_id
  LEFT JOIN users u ON u.id = o.user_id
  LEFT JOIN groups g ON g.id = o.group_id
)`;

const projectionColumnsSql = `
  id,
  request_id,
  user_id,
  user_email,
  api_key_name,
  api_key_deleted,
  COALESCE(api_key_prefix, attempted_key_prefix) AS api_key_prefix,
  account_id,
  account_name,
  platform,
  CASE
    WHEN COALESCE(requested_model, '') <> '' THEN requested_model
    ELSE model
  END AS model,
  upstream_model,
  inbound_endpoint,
  upstream_endpoint,
  group_id,
  group_name,
  request_type,
  stream,
  error_phase,
  error_type,
  severity,
  COALESCE(upstream_status_code, status_code, 0) AS display_status_code,
  status_code AS recorded_status_code,
  upstream_status_code,
  provider_error_code,
  provider_error_type,
  is_business_limited,
  CASE
    WHEN COALESCE(is_business_limited, false) THEN 'quota'
    WHEN LOWER(COALESCE(error_phase, '')) = 'auth' THEN 'auth'
    WHEN LOWER(COALESCE(error_phase, '')) = 'routing' THEN 'service_unavailable'
    WHEN LOWER(COALESCE(error_phase, '')) IN ('account_auth', 'upstream', 'network') THEN 'upstream'
    WHEN LOWER(COALESCE(error_phase, '')) = 'internal' THEN 'internal'
    WHEN LOWER(COALESCE(error_phase, '')) = 'request'
      AND LOWER(COALESCE(error_type, '')) = 'rate_limit_error' THEN 'rate_limit'
    WHEN LOWER(COALESCE(error_phase, '')) = 'request'
      AND LOWER(COALESCE(error_type, '')) IN ('billing_error', 'subscription_error') THEN 'quota'
    WHEN LOWER(COALESCE(error_phase, '')) = 'request'
      AND LOWER(COALESCE(error_type, '')) = 'invalid_request_error' THEN 'invalid_request'
    WHEN LOWER(COALESCE(error_phase, '')) = 'request'
      AND LOWER(COALESCE(error_type, '')) = 'cyber_policy' THEN 'cyber'
    ELSE 'other'
  END AS category,
  recovered,
  created_at,
  ${stablePhraseSql} AS stable_phrases
`;

const errorListSql = `
${baseProjectionSql}
SELECT ${projectionColumnsSql}
FROM enriched
WHERE (COALESCE(status_code, 0) >= 400 OR error_type = 'cyber_policy')
ORDER BY created_at DESC, id DESC
LIMIT $1
`;

const errorGetSql = `
${baseProjectionSql}
SELECT ${projectionColumnsSql}
FROM enriched
WHERE request_id = $1
ORDER BY created_at, id
`;

function integer(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function maskedIdentity(row: Row): string {
  const raw = String(row.user_email ?? "");
  if (!raw) return "unknown";
  return `${raw.slice(0, 3)}***`;
}

function timestamp(value: unknown, timezone: string): string | null {
  if (!(value instanceof Date)) return null;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(value).replace(" ", "T");
}

export function projectErrorDetailRow(row: Row, timezone: string): Row {
  return {
    recordId: String(row.id ?? ""),
    requestId: row.request_id ?? null,
    user: maskedIdentity(row),
    apiKeyName: row.api_key_name ?? null,
    apiKeyDeleted: row.api_key_deleted === true,
    apiKeyPrefix: row.api_key_prefix ?? null,
    accountId: integer(row.account_id),
    accountName: row.account_name ?? null,
    platform: row.platform ?? null,
    model: row.model ?? null,
    upstreamModel: row.upstream_model ?? null,
    inboundEndpoint: row.inbound_endpoint ?? null,
    upstreamEndpoint: row.upstream_endpoint ?? null,
    groupId: integer(row.group_id),
    groupName: row.group_name ?? null,
    requestType: integer(row.request_type),
    stream: row.stream === true,
    phase: row.error_phase ?? null,
    errorType: row.error_type ?? null,
    severity: row.severity ?? null,
    statusCode: integer(row.display_status_code),
    recordedStatusCode: integer(row.recorded_status_code),
    upstreamStatusCode: integer(row.upstream_status_code),
    providerErrorCode: row.provider_error_code ?? null,
    providerErrorType: row.provider_error_type ?? null,
    businessLimited: row.is_business_limited === true,
    category: row.category ?? "other",
    recovered: row.recovered === true,
    customerVisible:
      (integer(row.recorded_status_code) ?? 0) >= 400 ||
      String(row.error_type ?? "").toLowerCase() === "cyber_policy",
    stablePhrases: row.stable_phrases ?? {},
    createdAt: timestamp(row.created_at, timezone),
  };
}

async function query(
  config: AppConfig,
  sqlText: string,
  params: unknown[],
  databaseUrlOverride: string | null,
): Promise<{ rows: Row[]; queryDurationMs: number; totalDurationMs: number }> {
  const databaseUrl = databaseUrlOverride ?? readSecret(config, config.sub2api.scoreDatabase);
  const database = new SQL(databaseUrl, { max: 1 });
  const startedAt = performance.now();
  try {
    let queryDurationMs = 0;
    const rows = await database.begin(async (transaction) => {
      await transaction.unsafe("SET TRANSACTION READ ONLY");
      await transaction.unsafe(`SET LOCAL statement_timeout = '${config.sub2api.scoreDatabase.statementTimeoutMs}ms'`);
      const queryStartedAt = performance.now();
      const result = await transaction.unsafe(sqlText, params);
      queryDurationMs = Math.round((performance.now() - queryStartedAt) * 10) / 10;
      return result;
    }) as unknown as Row[];
    return {
      rows,
      queryDurationMs,
      totalDurationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    };
  } finally {
    await database.close();
  }
}

export async function collectErrorListFromDatabase(
  config: AppConfig,
  limit: number,
  databaseUrlOverride: string | null = null,
): Promise<Row> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    throw new Error("error list limit must be an integer from 1 to 10000");
  }
  const result = await query(config, errorListSql, [limit], databaseUrlOverride);
  return {
    ok: true,
    mode: "error-list-postgresql",
    limit,
    timezone: config.monitor.timezone,
    databaseQueries: 1,
    queryDurationMs: result.queryDurationMs,
    totalDurationMs: result.totalDurationMs,
    records: result.rows.map((row) => projectErrorDetailRow(row, config.monitor.timezone)),
    valuesPrinted: false,
  };
}

export async function collectErrorRequestFromDatabase(
  config: AppConfig,
  requestId: string,
  databaseUrlOverride: string | null = null,
): Promise<Row> {
  if (!requestId.trim()) throw new Error("request id is required");
  const result = await query(config, errorGetSql, [requestId.trim()], databaseUrlOverride);
  if (result.rows.length === 0) throw new Error(`request id not found: ${requestId}`);
  return {
    ok: true,
    mode: "error-request-postgresql",
    requestId,
    timezone: config.monitor.timezone,
    databaseQueries: 1,
    queryDurationMs: result.queryDurationMs,
    totalDurationMs: result.totalDurationMs,
    attempts: result.rows.map((row) => projectErrorDetailRow(row, config.monitor.timezone)),
    recovered: result.rows.some((row) => row.recovered === true),
    customerVisible: result.rows.some((row) =>
      (integer(row.recorded_status_code) ?? 0) >= 400 ||
      String(row.error_type ?? "").toLowerCase() === "cyber_policy"
    ),
    valuesPrinted: false,
  };
}

export const errorListQuery = errorListSql;
export const errorGetQuery = errorGetSql;
