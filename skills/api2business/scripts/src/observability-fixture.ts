import type { AdminHttpClient } from '../../../../src/admin-http-client';
import { observabilitySql } from '../../../../src/observability-sql';

// The normal read broker executes VALUES-only fixtures; no business rows or writes.
export async function verifyObservationWindow(client: AdminHttpClient) {
  const fixture=`WITH accounts AS (
    SELECT 1::bigint id,'fixture upstream'::text name,'openai'::text platform,'apikey'::text type,'{"base_url":"https://fixture.example"}'::jsonb credentials,NULL::timestamptz deleted_at
  ), users AS (SELECT 99::bigint id,'monitor-user@sub2api.platform-infra.local'::text email),
  api_keys AS (SELECT 99::bigint id,99::bigint user_id,'api2business-probe-fixture'::text name),
  groups AS (SELECT 1::bigint id,'business'::text name),
  usage_logs AS (
    SELECT id,request_id,at::timestamptz created_at,1::bigint account_id,1::bigint group_id,api_key_id,
      true AS stream,'fixture-model'::text model,ttft AS first_token_ms,actual_cost,rate_multiplier
    FROM (VALUES
      (1,'r1','2026-01-01T00:00:00Z',1,5000,2::numeric,2::numeric),
      (2,'r1','2026-01-01T00:30:00Z',1,20000,2,2),
      (3,'r2','2026-01-01T01:00:00Z',1,10000,4,2),
      (4,'probe','2026-01-01T01:00:00Z',99,10,100,1),
      (5,NULL,'2026-01-01T01:00:00Z',1,20,1,1),
      (6,'end-boundary','2026-01-01T02:00:00Z',1,10,100,1)
    ) t(id,request_id,at,api_key_id,ttft,actual_cost,rate_multiplier)
  ), ops_error_logs AS (
    SELECT id,request_id,at::timestamptz created_at,1::bigint account_id,1::bigint group_id,api_key_id,
      status_code,NULL::int upstream_status_code,NULL::text network_error_type,false is_business_limited,
      phase AS error_phase,kind AS error_type,'fixture-model'::text model,NULL::text requested_model,
      '/v1/responses'::text inbound_endpoint,NULL::text error_message,NULL::text error_body,
      NULL::text upstream_error_message,NULL::text upstream_error_detail
    FROM (VALUES
      (1,'r2','2026-01-01T00:50:00Z',1,502,'upstream','gateway'),
      (2,'r3','2026-01-01T01:00:00Z',1,502,'upstream','gateway'),
      (3,'r3','2026-01-01T01:10:00Z',1,429,'upstream','rate_limit'),
      (4,'r4','2026-01-01T01:00:00Z',1,502,'upstream','failover_event'),
      (5,'r5','2026-01-01T01:00:00Z',1,0,NULL,NULL),
      (6,'probe-error','2026-01-01T01:00:00Z',99,500,'internal','unknown')
    ) t(id,request_id,at,api_key_id,status_code,phase,kind)
  ), `;
  const result=await client.sub2ApiRead<{facts:Record<string,any>}>({key:`observability-fixture:${crypto.randomUUID()}`,kind:'observability.fixture',
    sql:fixture+observabilitySql.replace(/^\s*WITH\s/u,''),parameters:['2026-01-01T00:00:00Z','2026-01-01T02:00:00Z',
      JSON.stringify([
        {account_id:1,at:'2025-12-31T00:00:00Z',rate_cny:0.5},
        {account_id:1,at:'2026-01-01T00:15:00Z',rate_cny:0.5},
        {account_id:1,at:'2026-01-01T00:45:00Z',rate_cny:1},
        {account_id:1,at:'2026-01-01T03:00:00Z',rate_cny:10},
      ])],priority:'manual',cacheMode:'bypass-cache'});
  const facts=result.rows[0]?.facts ?? {};
  const checks={uniqueSuccess: facts.succeeded===2,uniqueFinalFailures:facts.failed===2,recovered:facts.recoveredRequests===1,
    missingId:facts.missingRequestIdRecords===1,excludedProbe:facts.excludedProbeRecords===2,ttft:facts.ttftP95Ms===19500,
    sameWindowCostRecords:facts.costAccounts?.[0]?.records===4,historicalCost:facts.costAccounts?.[0]?.historical_cost_cny===4,
    unknownRetained:facts.unknownExamples?.[0]?.request_id==='r5'};
  return {ok:Object.values(checks).every(Boolean),checks,queryDurationMs:result.queryDurationMs,mutation:false,valuesPrinted:false};
}
