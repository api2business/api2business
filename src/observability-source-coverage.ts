import { audioRequestSql } from "./scoring-error-policy";

// Missing-usage warnings are evidence gaps, not additional successes or failures.
// Never return the free-form extra object, request bodies, session IDs or credentials.
export const sourceCoverageSql = `WITH probe_requests AS (
  SELECT * FROM jsonb_to_recordset($3::jsonb) AS p("clientRequestId" text,"accountId" bigint,
    "startedAt" timestamptz,"completedAt" timestamptz)
), probe_keys AS (
  SELECT k.id FROM api_keys k LEFT JOIN users u ON u.id=k.user_id
  WHERE u.email='monitor-user@sub2api.platform-infra.local'
    OR LOWER(COALESCE(k.name,'')) LIKE 'api2business-probe-%'
), source AS (
  SELECT l.id,l.created_at,l.request_id,l.account_id,
    COALESCE(NULLIF(l.model,''),NULLIF(l.extra->>'model','')) AS model,
    NULLIF(l.extra->>'requested_model','') AS requested_model,
    NULLIF(l.extra->>'upstream_model','') AS upstream_model,
    l.extra->>'inbound_endpoint' AS inbound_endpoint,
    l.extra->>'terminal_event' AS terminal_event,
    l.extra->>'client_disconnected' AS client_disconnected,
    l.extra->>'suppressed_since_last' AS suppressed_since_last,
    (p.id IS NOT NULL OR LOWER(COALESCE(g.name,'')) LIKE 'api2business-probe-%'
      OR EXISTS (SELECT 1 FROM probe_requests pr WHERE pr."clientRequestId"=l.client_request_id
        AND pr."accountId"=l.account_id AND l.created_at >= pr."startedAt"
        AND l.created_at <= pr."completedAt")) AS probe
  FROM ops_system_logs l LEFT JOIN probe_keys p ON p.id=l.api_key_id
  LEFT JOIN api_keys k ON k.id=l.api_key_id LEFT JOIN groups g ON g.id=k.group_id
  WHERE l.created_at >= $1::timestamptz AND l.created_at < $2::timestamptz
    AND l.message='openai_usage.success_missing_usage'
), eligible AS (
  SELECT * FROM source s WHERE NOT probe AND NOT ${audioRequestSql("s", true)}
), unresolved AS (
  SELECT DISTINCT ON (COALESCE(NULLIF(TRIM(s.request_id),''),'missing-id:'||s.id::text)) s.*
  FROM eligible s WHERE NULLIF(TRIM(s.request_id),'') IS NULL
    OR NOT EXISTS (SELECT 1 FROM usage_logs u WHERE u.request_id=s.request_id
      AND u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz)
  ORDER BY COALESCE(NULLIF(TRIM(s.request_id),''),'missing-id:'||s.id::text),s.created_at DESC,s.id DESC
)
SELECT jsonb_build_object(
  'observedWarningRecords',(SELECT COUNT(*) FROM source),
  'excludedProbeRecords',(SELECT COUNT(*) FROM source WHERE probe),
  'excludedAudioRecords',(SELECT COUNT(*) FROM source s WHERE NOT probe AND ${audioRequestSql("s", true)}),
  'unrepresentedRequests',(SELECT COUNT(*) FROM unresolved),
  'suppressedWarningRecords',(SELECT COALESCE(SUM(CASE WHEN suppressed_since_last ~ '^[0-9]{1,18}$'
    THEN suppressed_since_last::numeric ELSE 0 END),0) FROM source),
  'modelBreakdown',COALESCE((SELECT jsonb_agg(t) FROM (
    SELECT requested_model,model,upstream_model,COUNT(*)::int AS requests FROM unresolved
    GROUP BY requested_model,model,upstream_model ORDER BY COUNT(*) DESC
  ) t),'[]'::jsonb),
  'examples',COALESCE((SELECT jsonb_agg(t) FROM (
    SELECT request_id,account_id,created_at,requested_model,model,upstream_model,
      terminal_event,client_disconnected FROM unresolved ORDER BY created_at DESC LIMIT 10
  ) t),'[]'::jsonb)
) AS coverage`;

export function sourceCoverageFacts(value: Record<string, unknown> | null) {
  const requests = typeof value?.unrepresentedRequests === "number" ? value.unrepresentedRequests : null;
  const suppressed = typeof value?.suppressedWarningRecords === "number" ? value.suppressedWarningRecords : null;
  return { ...value, source: "Sub2API ops_system_logs openai_usage.success_missing_usage",
    complete: requests === 0 && suppressed === 0,
    limitations: ["日志按采样输出，未记录的请求及被抑制日志的模型和归属未知。",
      "缺用量警告不加入成功、失败或TTFT样本；模型未知时不能推定为Luna或探活。"],
  };
}
