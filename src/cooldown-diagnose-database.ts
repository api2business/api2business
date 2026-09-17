import type { AppConfig } from "./config";
import type { Sub2ApiReadClient, Sub2ApiReadPriority } from "./sub2api-read-executor";

type Row = Record<string, unknown>;

// Keep this query read-only and bounded. The event table is the source of truth
// for trigger history; account state is only used to show whether the block is
// still active at query time.
export const cooldownDiagnoseQuery = `
WITH internal_probe_keys AS (
  SELECT k.id
  FROM api_keys k
  LEFT JOIN users owner ON owner.id = k.user_id
  WHERE owner.email = 'monitor-user@sub2api.platform-infra.local'
    OR LOWER(COALESCE(k.name, '')) LIKE 'api2business-probe-%'
), cooldown_events AS (
  SELECT
    l.id,
    l.created_at,
    l.message,
    l.request_id,
    l.account_id,
    COALESCE(a.name, 'unattributed') AS account_name,
    COALESCE(NULLIF(l.model, ''), NULLIF(l.extra->>'model', ''), NULLIF(l.extra->>'requested_model', ''), 'unknown') AS model,
    CASE
      WHEN COALESCE(l.extra->>'status_code', '') ~ '^[0-9]+$' THEN (l.extra->>'status_code')::int
      WHEN l.message ILIKE '%openai_403%' THEN 403
      WHEN l.message ILIKE '%oauth_401%' THEN 401
      ELSE NULL
    END AS status_code,
    CASE WHEN COALESCE(l.extra->>'rule_index', '') ~ '^[0-9]+$' THEN (l.extra->>'rule_index')::int END AS rule_index,
    NULLIF(l.extra->>'matched_keyword', '') AS matched_keyword,
    NULLIF(l.extra->>'until', '') AS event_until,
    NULLIF(l.extra->>'reason', '') AS event_reason,
    COALESCE(a.temp_unschedulable_until > NOW(), false) AS currently_active,
    a.temp_unschedulable_until AS current_until,
    a.temp_unschedulable_reason AS current_reason
  FROM ops_system_logs l
  LEFT JOIN accounts a ON a.id = l.account_id
  WHERE l.created_at >= $2::timestamptz
    AND l.created_at < $3::timestamptz
    AND (
      l.message ILIKE '%temp_unschedulable%'
      OR l.message ILIKE '%temp-unschedulable%'
    )
    AND NOT EXISTS (
      SELECT 1 FROM internal_probe_keys probe WHERE probe.id = l.api_key_id
    )
    AND ($4::text IS NULL OR l.account_id::text = $4::text OR a.name = $4::text)
    AND ($5::text IS NULL OR LOWER(COALESCE(l.model, l.extra->>'model', l.extra->>'requested_model', 'unknown')) = LOWER($5::text))
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT $1
), enriched AS (
  SELECT
    c.*,
    COALESCE(error_facts.error_count, 0)::int AS linked_error_count,
    COALESCE(error_facts.upstream_error_count, 0)::int AS linked_upstream_error_count,
    COALESCE(error_facts.client_error_count, 0)::int AS linked_client_error_count,
    COALESCE(error_facts.error_status_code, 0)::int AS linked_status_code,
    error_facts.error_phase AS linked_error_phase,
    COALESCE(error_facts.correlation, 'none') AS correlation,
    EXISTS (
      SELECT 1 FROM ops_system_logs f
      WHERE (
        (c.request_id IS NOT NULL AND f.request_id = c.request_id)
        OR (c.request_id IS NULL AND f.account_id = c.account_id
          AND f.created_at BETWEEN c.created_at - INTERVAL '30 seconds' AND c.created_at + INTERVAL '30 seconds')
      )
        AND f.message LIKE '%upstream_failover_switching'
    ) AS followed_by_failover
  FROM cooldown_events c
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) AS error_count,
      COUNT(*) FILTER (WHERE COALESCE(e.upstream_status_code, e.status_code, 0) >= 500)::int AS upstream_error_count,
      COUNT(*) FILTER (WHERE COALESCE(e.upstream_status_code, e.status_code, 0) BETWEEN 400 AND 499)::int AS client_error_count,
      (ARRAY_AGG(COALESCE(e.upstream_status_code, e.status_code, 0) ORDER BY e.created_at DESC, e.id DESC))[1] AS error_status_code,
      (ARRAY_AGG(COALESCE(e.error_phase, 'unknown') ORDER BY e.created_at DESC, e.id DESC))[1] AS error_phase,
      CASE WHEN c.request_id IS NOT NULL THEN 'exact' ELSE 'temporal' END AS correlation
    FROM ops_error_logs e
    WHERE (
      (c.request_id IS NOT NULL AND e.request_id = c.request_id)
      OR (c.request_id IS NULL AND e.account_id = c.account_id
        AND e.created_at BETWEEN c.created_at - INTERVAL '30 seconds' AND c.created_at + INTERVAL '30 seconds')
    )
    GROUP BY c.request_id
  ) error_facts ON true
), classified AS (
  SELECT *, CASE
    WHEN linked_client_error_count > 0 AND linked_upstream_error_count = 0
      AND LOWER(COALESCE(linked_error_phase, '')) IN ('client', 'request', 'routing')
      THEN 'suspect_client_or_routing_error'
    WHEN linked_client_error_count > 0 AND linked_upstream_error_count = 0 THEN 'linked_upstream_4xx'
    WHEN linked_upstream_error_count > 0 THEN 'linked_upstream_error'
    WHEN linked_error_count > 0 THEN 'linked_non_upstream_error'
    WHEN request_id IS NULL THEN 'unverified_no_request_id'
    ELSE 'no_linked_error_evidence'
  END AS evidence_class
  FROM enriched
)
SELECT
  (SELECT COUNT(*)::int FROM cooldown_events) AS sampled_event_rows,
  COUNT(*)::int AS cooldown_events,
  COUNT(DISTINCT account_id)::int AS affected_accounts,
  COUNT(*) FILTER (WHERE request_id IS NULL)::int AS no_request_id_events,
  COUNT(*) FILTER (WHERE linked_error_count > 0)::int AS linked_error_events,
  COUNT(*) FILTER (WHERE correlation = 'temporal')::int AS temporal_linked_events,
  COUNT(*) FILTER (WHERE linked_upstream_error_count > 0)::int AS linked_upstream_events,
  COUNT(*) FILTER (WHERE linked_client_error_count > 0 AND linked_upstream_error_count = 0
    AND LOWER(COALESCE(linked_error_phase, '')) IN ('client', 'request', 'routing'))::int AS suspect_client_events,
  COUNT(*) FILTER (WHERE followed_by_failover)::int AS followed_by_failover_events,
  COUNT(*) FILTER (WHERE currently_active)::int AS currently_active_events,
  COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT(
    'eventId', id,
    'triggeredAt', created_at,
    'event', message,
    'requestId', request_id,
    'accountId', account_id,
    'accountName', account_name,
    'model', model,
    'statusCode', status_code,
    'ruleIndex', rule_index,
    'matchedKeyword', matched_keyword,
    'eventUntil', event_until,
    'eventReason', event_reason,
    'currentUntil', current_until,
    'currentlyActive', currently_active,
    'linkedErrorCount', linked_error_count,
    'linkedStatusCode', NULLIF(linked_status_code, 0),
    'linkedErrorPhase', linked_error_phase,
    'correlation', correlation,
    'followedByFailover', followed_by_failover,
    'evidenceClass', evidence_class
  ) ORDER BY created_at DESC, id DESC), '[]'::jsonb) AS events
FROM classified
`;

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? "").trim();
  return text || null;
}

export function projectCooldownDiagnoseRow(row: Row): Row {
  return {
    summary: {
      sampledEventRows: integer(row.sampled_event_rows),
      cooldownEvents: integer(row.cooldown_events),
      affectedAccounts: integer(row.affected_accounts),
      noRequestIdEvents: integer(row.no_request_id_events),
      linkedErrorEvents: integer(row.linked_error_events),
      temporalLinkedEvents: integer(row.temporal_linked_events),
      linkedUpstreamEvents: integer(row.linked_upstream_events),
      suspectClientEvents: integer(row.suspect_client_events),
      followedByFailoverEvents: integer(row.followed_by_failover_events),
      currentlyActiveEvents: integer(row.currently_active_events),
    },
    events: Array.isArray(row.events) ? row.events : [],
  };
}

export async function collectCooldownDiagnosisFromDatabase(
  config: AppConfig,
  reads: Sub2ApiReadClient,
  limit: number,
  since: string,
  until: string,
  accountSelector: string | null = null,
  modelSelector: string | null = null,
  priority: Sub2ApiReadPriority = "manual",
): Promise<Row> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("cooldown diagnose limit must be an integer from 1 to 10000");
  const start = new Date(since);
  const end = new Date(until);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new Error("cooldown diagnose requires since < until as ISO timestamps");
  const startedAt = performance.now();
  const query = await reads.query<Row>({
    key: JSON.stringify(["errors.cooldowns", limit, start.toISOString(), end.toISOString(), accountSelector, modelSelector]),
    kind: "errors.cooldowns",
    sql: cooldownDiagnoseQuery,
    parameters: [limit, start.toISOString(), end.toISOString(), accountSelector, modelSelector],
    priority,
    cacheMode: "prefer-cache",
  });
  const projected = projectCooldownDiagnoseRow(query.rows[0] ?? {});
  return {
    ok: true,
    mode: "cooldown-diagnose-postgresql",
    limit,
    since: start.toISOString(),
    until: end.toISOString(),
    accountSelector,
    modelSelector,
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
    interpretation: {
      suspectClientEventsAreCandidates: true,
      noRequestIdEventsRequireLogCorrelation: true,
      currentStateIsNotHistoricalState: true,
      evidenceClass: "suspect_client_or_routing_error means a cooldown event linked only to 4xx errors in the same request; it is a review candidate, not proof of a false trigger.",
    },
    valuesPrinted: false,
    timestampFields: [iso(start), iso(end)],
  };
}
