import type { AdminHttpClient } from "../../../../src/admin-http-client";
import { sourceCoverageSql } from "../../../../src/observability-source-coverage";

export async function verifySourceCoverageWindow(client: AdminHttpClient) {
  const fixture=`WITH users AS (
    SELECT * FROM (VALUES (1::bigint,'customer@example.invalid'),(99,'monitor-user@sub2api.platform-infra.local')) t(id,email)
  ), api_keys AS (
    SELECT * FROM (VALUES (1::bigint,1::bigint,1::bigint,'customer'),(99,99,1,'api2business-probe-fixture')) t(id,user_id,group_id,name)
  ), groups AS (SELECT 1::bigint id,'business'::text name),
  usage_logs AS (SELECT 'represented'::text request_id,'2026-01-01T01:00:00Z'::timestamptz created_at),
  ops_system_logs AS (
    SELECT id,request_id,at::timestamptz created_at,1::bigint account_id,api_key_id,model,
      'openai_usage.success_missing_usage'::text message,
      jsonb_build_object('inbound_endpoint','/v1/responses','terminal_event','response.completed',
        'client_disconnected',false,'suppressed_since_last',CASE WHEN id=8 THEN '2' ELSE '0' END) extra
    FROM (VALUES
      (1,'gap','2026-01-01T00:00:00Z',1::bigint,'fixture-model'),
      (2,'gap','2026-01-01T00:01:00Z',1,'fixture-model'),
      (3,'represented','2026-01-01T01:00:00Z',1,'fixture-model'),
      (4,'probe','2026-01-01T01:00:00Z',99,'fixture-model'),
      (5,'audio','2026-01-01T01:00:00Z',1,'gpt-4o-audio-preview'),
      (6,'end-boundary','2026-01-01T02:00:00Z',1,'fixture-model'),
      (7,'before','2025-12-31T23:59:59Z',1,'fixture-model'),
      (8,'unknown','2026-01-01T01:10:00Z',1,NULL),
      (9,'luna','2026-01-01T01:20:00Z',1,'gpt-5.6-luna')
    ) t(id,request_id,at,api_key_id,model)
  ), `;
  const result=await client.sub2ApiRead<{coverage:Record<string,any>}>({
    key:`observability-source-fixture:${crypto.randomUUID()}`,kind:"observability.fixture",
    sql:fixture+sourceCoverageSql.replace(/^WITH\s/u,""),parameters:["2026-01-01T00:00:00Z","2026-01-01T02:00:00Z"],
    priority:"manual",cacheMode:"bypass-cache",
  });
  const coverage=result.rows[0]?.coverage ?? {};
  const checks={sameWindow:coverage.observedWarningRecords===7,deduplicatedUnrepresented:coverage.unrepresentedRequests===3,
    probeExcluded:coverage.excludedProbeRecords===1,audioExcluded:coverage.excludedAudioRecords===1,
    suppressionRetained:coverage.suppressedWarningRecords===2,
    unknownModelRetained:coverage.modelBreakdown?.some((r:any)=>r.model===null && r.requests===1),
    rawLunaRetained:coverage.modelBreakdown?.some((r:any)=>r.model==='gpt-5.6-luna' && r.requests===1),
    exactUsageLinked:!coverage.examples?.some((r:any)=>r.request_id==='represented')};
  return {ok:Object.values(checks).every(Boolean),checks,queryDurationMs:result.queryDurationMs,mutation:false};
}
