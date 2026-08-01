import type { AppConfig } from "./config";
import type {
  Sub2ApiReadClient,
  Sub2ApiReadPriority,
} from "./sub2api-read-executor";

type Row = Record<string, unknown>;

const errorDiagnoseSql = `
WITH target_accounts AS (
  SELECT a.id, a.name
  FROM accounts a
  WHERE a.deleted_at IS NULL
    AND ($2::text IS NULL OR a.id::text = $2::text OR a.name = $2::text)
    AND (
      $3::text IS NULL
      OR EXISTS (
        SELECT 1
        FROM account_groups ag
        JOIN groups g ON g.id = ag.group_id AND g.deleted_at IS NULL
        WHERE ag.account_id = a.id
          AND (g.id::text = $3::text OR g.name = $3::text)
      )
    )
),
selected_errors AS (
  SELECT
    o.id,
    o.request_id,
    COALESCE(o.request_id, 'error:' || o.id::text) AS request_key,
    o.account_id,
    COALESCE(a.name, 'unattributed') AS account_name,
    COALESCE(o.requested_model, o.model, 'unknown') AS model,
    o.inbound_endpoint,
    o.upstream_endpoint,
    o.stream,
    o.status_code,
    o.upstream_status_code,
    COALESCE(o.upstream_status_code, o.status_code, 0) AS display_status_code,
    COALESCE(o.error_phase, 'unknown') AS error_phase,
    COALESCE(o.error_type, 'unknown') AS error_type,
    o.provider_error_code,
    o.provider_error_type,
    o.is_business_limited,
    o.created_at,
    LOWER(
      COALESCE(o.error_message, '') || ' ' ||
      COALESCE(o.error_body, '') || ' ' ||
      COALESCE(o.upstream_error_message, '') || ' ' ||
      COALESCE(o.upstream_error_detail, '')
    ) AS message_text
  FROM ops_error_logs o
  LEFT JOIN target_accounts a ON a.id = o.account_id
  WHERE (($2::text IS NULL AND $3::text IS NULL) OR a.id IS NOT NULL)
    AND (COALESCE(o.status_code, 0) >= 400 OR o.error_type = 'cyber_policy')
    AND ($6::text IS NULL OR o.request_id::text = ANY(string_to_array($6::text, ',')))
  ORDER BY o.created_at DESC, o.id DESC
  LIMIT $1
),
classified AS (
  SELECT
    e.*,
    EXISTS (
      SELECT 1 FROM usage_logs u
      WHERE e.request_id IS NOT NULL AND u.request_id = e.request_id
    ) AS recovered,
    CASE
      WHEN message_text LIKE '%invalid_encrypted_content%' THEN 'invalid_encrypted_content'
      WHEN message_text LIKE '%bad_response_status_code%' THEN 'bad_response_status_code'
      WHEN message_text LIKE '%selected model is at capacity%' THEN 'selected_model_at_capacity'
      WHEN message_text LIKE '%insufficient account balance%'
        OR message_text LIKE '%insufficient balance%' THEN 'insufficient_balance'
      WHEN message_text LIKE '%weekly limit%' THEN 'weekly_limit'
      WHEN message_text LIKE '%usage limit%' THEN 'usage_limit'
      WHEN message_text LIKE '%no available channel for model%' THEN 'no_available_channel'
      WHEN message_text LIKE '%model_not_found%'
        OR message_text LIKE '%model not found%' THEN 'model_not_found'
      WHEN message_text LIKE '%overloaded%' THEN 'upstream_overloaded'
      WHEN message_text LIKE '%error code: 524%' THEN 'error_code_524'
      WHEN message_text LIKE '%error code: 504%' THEN 'error_code_504'
      WHEN message_text LIKE '%error code: 502%' THEN 'error_code_502'
      WHEN message_text LIKE '%gateway timeout%' THEN 'gateway_timeout'
      WHEN message_text LIKE '%bad gateway%' THEN 'bad_gateway'
      WHEN message_text LIKE '%unexpected eof%' THEN 'unexpected_eof'
      WHEN message_text LIKE '%stream was interrupted%'
        OR message_text LIKE '%stream interrupted%' THEN 'stream_interrupted'
      ELSE 'unclassified'
    END AS stable_phrase,
    CONCAT_WS(':',
      COALESCE(e.upstream_status_code, e.status_code, 0)::text,
      COALESCE(e.error_phase, 'unknown'),
      COALESCE(e.error_type, 'unknown'),
      COALESCE(e.provider_error_code, e.provider_error_type, '-'),
      CASE
        WHEN message_text LIKE '%invalid_encrypted_content%' THEN 'invalid_encrypted_content'
        WHEN message_text LIKE '%bad_response_status_code%' THEN 'bad_response_status_code'
        WHEN message_text LIKE '%selected model is at capacity%' THEN 'selected_model_at_capacity'
        WHEN message_text LIKE '%insufficient account balance%'
          OR message_text LIKE '%insufficient balance%' THEN 'insufficient_balance'
        WHEN message_text LIKE '%weekly limit%' THEN 'weekly_limit'
        WHEN message_text LIKE '%usage limit%' THEN 'usage_limit'
        WHEN message_text LIKE '%no available channel for model%' THEN 'no_available_channel'
        WHEN message_text LIKE '%model_not_found%'
          OR message_text LIKE '%model not found%' THEN 'model_not_found'
        WHEN message_text LIKE '%overloaded%' THEN 'upstream_overloaded'
        WHEN message_text LIKE '%error code: 524%' THEN 'error_code_524'
        WHEN message_text LIKE '%error code: 504%' THEN 'error_code_504'
        WHEN message_text LIKE '%error code: 502%' THEN 'error_code_502'
        WHEN message_text LIKE '%gateway timeout%' THEN 'gateway_timeout'
        WHEN message_text LIKE '%bad gateway%' THEN 'bad_gateway'
        WHEN message_text LIKE '%unexpected eof%' THEN 'unexpected_eof'
        WHEN message_text LIKE '%stream was interrupted%'
          OR message_text LIKE '%stream interrupted%' THEN 'stream_interrupted'
        ELSE 'unclassified'
      END
    ) AS signature
  FROM selected_errors e
),
request_chains AS (
  SELECT
    request_key,
    MIN(request_id::text) AS request_id,
    MIN(created_at) AS first_at,
    MAX(created_at) AS last_at,
    BOOL_OR(recovered) AS recovered,
    COUNT(*)::int AS attempt_count,
    COUNT(DISTINCT account_id)::int AS account_count,
    COUNT(*) > 1 OR COUNT(DISTINCT account_id) > 1 AS failover_triggered,
    (ARRAY_AGG(model ORDER BY created_at, id))[1] AS model,
    (ARRAY_AGG(inbound_endpoint ORDER BY created_at, id))[1] AS inbound_endpoint,
    (ARRAY_AGG(upstream_endpoint ORDER BY created_at, id))[1] AS upstream_endpoint,
    BOOL_OR(stream) AS stream,
    (ARRAY_AGG(signature ORDER BY created_at DESC, id DESC))[1] AS final_signature,
    (ARRAY_AGG(display_status_code ORDER BY created_at DESC, id DESC))[1] AS final_status_code,
    JSONB_AGG(JSONB_BUILD_OBJECT(
      'accountId', account_id,
      'accountName', account_name,
      'statusCode', display_status_code,
      'recordedStatusCode', status_code,
      'upstreamStatusCode', upstream_status_code,
      'phase', error_phase,
      'errorType', error_type,
      'providerErrorCode', provider_error_code,
      'providerErrorType', provider_error_type,
      'businessLimited', COALESCE(is_business_limited, false),
      'stablePhrase', stable_phrase,
      'signature', signature,
      'createdAt', created_at
    ) ORDER BY created_at, id) AS attempts
  FROM classified
  GROUP BY request_key
),
signature_rows AS (
  SELECT
    signature,
    stable_phrase,
    COUNT(DISTINCT request_key)::int AS requests,
    COUNT(DISTINCT request_key) FILTER (WHERE NOT recovered)::int AS customer_visible,
    COUNT(DISTINCT request_key) FILTER (WHERE recovered)::int AS recovered,
    COUNT(DISTINCT account_id)::int AS accounts
  FROM classified
  GROUP BY signature, stable_phrase
),
ranked_signatures AS (
  SELECT *, ROW_NUMBER() OVER (
    ORDER BY customer_visible DESC, requests DESC, signature
  ) AS rank
  FROM signature_rows
),
ranked_chains AS (
  SELECT *, ROW_NUMBER() OVER (
    ORDER BY (NOT recovered) DESC, failover_triggered DESC,
      attempt_count DESC, last_at DESC, request_key
  ) AS rank
  FROM request_chains
)
SELECT
  (SELECT COUNT(*)::int FROM classified) AS sampled_error_rows,
  (SELECT COUNT(*)::int FROM request_chains) AS distinct_requests,
  (SELECT COUNT(*) FILTER (WHERE NOT recovered)::int FROM request_chains)
    AS customer_visible_requests,
  (SELECT COUNT(*) FILTER (WHERE recovered)::int FROM request_chains)
    AS recovered_requests,
  (SELECT COUNT(*) FILTER (WHERE failover_triggered)::int FROM request_chains)
    AS failover_triggered_requests,
  (SELECT COUNT(*) FILTER (WHERE failover_triggered AND recovered)::int FROM request_chains)
    AS failover_recovered_requests,
  (SELECT COUNT(*) FILTER (WHERE failover_triggered AND NOT recovered)::int FROM request_chains)
    AS failover_failed_requests,
  COALESCE((
    SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
      'signature', signature,
      'stablePhrase', stable_phrase,
      'requests', requests,
      'customerVisible', customer_visible,
      'recovered', recovered,
      'accounts', accounts
    ) ORDER BY customer_visible DESC, requests DESC, signature)
    FROM ranked_signatures WHERE rank <= $4
  ), '[]'::jsonb) AS signatures,
  COALESCE((
    SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
      'requestId', request_id,
      'firstAt', first_at,
      'lastAt', last_at,
      'model', model,
      'inboundEndpoint', inbound_endpoint,
      'upstreamEndpoint', upstream_endpoint,
      'stream', stream,
      'attemptCount', attempt_count,
      'accountCount', account_count,
      'failoverTriggered', failover_triggered,
      'recovered', recovered,
      'customerVisible', NOT recovered,
      'finalStatusCode', final_status_code,
      'finalSignature', final_signature,
      'attempts', attempts
    ) ORDER BY (NOT recovered) DESC, failover_triggered DESC,
      attempt_count DESC, last_at DESC, request_key)
    FROM ranked_chains WHERE rank <= $5
  ), '[]'::jsonb) AS chains
`;

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function projectErrorDiagnoseRow(row: Row): Row {
  const summary = {
    sampledErrorRows: integer(row.sampled_error_rows),
    distinctRequests: integer(row.distinct_requests),
    customerVisibleRequests: integer(row.customer_visible_requests),
    recoveredRequests: integer(row.recovered_requests),
    failoverTriggeredRequests: integer(row.failover_triggered_requests),
    failoverRecoveredRequests: integer(row.failover_recovered_requests),
    failoverFailedRequests: integer(row.failover_failed_requests),
  };
  const signatures = Array.isArray(row.signatures) ? row.signatures : [];
  const chains = Array.isArray(row.chains) ? row.chains : [];
  return {
    summary,
    signatures,
    chains,
    analysisHints: {
      failoverWithoutRecovery: summary.failoverFailedRequests,
      unclassifiedSignatures: signatures.filter((item) =>
        typeof item === "object" && item !== null
        && (item as Row).stablePhrase === "unclassified"
      ).length,
    },
  };
}

export async function collectErrorDiagnosisFromDatabase(
  config: AppConfig,
  reads: Sub2ApiReadClient,
  limit: number,
  top: number,
  accountSelector: string | null = null,
  groupSelector: string | null = null,
  failoverRequestIds: string[] | null = null,
  priority: Sub2ApiReadPriority = "manual",
): Promise<Row> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    throw new Error("error diagnose limit must be an integer from 1 to 10000");
  }
  if (!Number.isInteger(top) || top < 1 || top > 100) {
    throw new Error("error diagnose top must be an integer from 1 to 100");
  }
  const startedAt = performance.now();
  const query = await reads.query<Row>({
    key: JSON.stringify([
      "errors.diagnose",
      limit,
      top,
      accountSelector,
      groupSelector,
      failoverRequestIds,
    ]),
    kind: "errors.diagnose",
    sql: errorDiagnoseSql,
    parameters: [
      limit,
      accountSelector,
      groupSelector,
      top,
      top,
      failoverRequestIds === null ? null : failoverRequestIds.join(","),
    ],
    priority,
    cacheMode: "prefer-cache",
  });
  const projected = projectErrorDiagnoseRow(query.rows[0] ?? {});
  const summary = projected.summary as Row;
  if (accountSelector !== null && integer(summary.sampledErrorRows) === 0) {
    throw new Error(`account selector resolved no recent errors: ${accountSelector}`);
  }
  if (groupSelector !== null && integer(summary.sampledErrorRows) === 0) {
    throw new Error(`group selector resolved no recent errors: ${groupSelector}`);
  }
  return {
    ok: true,
    mode: "error-diagnose-postgresql",
    limit,
    top,
    accountSelector,
    groupSelector,
    timezone: config.monitor.timezone,
    databaseQueries: query.cached ? 0 : 1,
    queueDurationMs: query.queueDurationMs,
    queryDurationMs: query.queryDurationMs,
    totalDurationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    queryStartedAt: query.queryStartedAt,
    queryCompletedAt: query.queryCompletedAt,
    deduplicated: query.deduplicated,
    cached: query.cached,
    ...projected,
    valuesPrinted: false,
  };
}

export const errorDiagnoseQuery = errorDiagnoseSql;
