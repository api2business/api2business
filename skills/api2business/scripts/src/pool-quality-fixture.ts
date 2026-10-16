import type { AppConfig } from '../../../../src/config';
import type { AdminHttpClient } from '../../../../src/admin-http-client';
import { collectPoolQualityErrors, collectPoolQualitySample } from '../../../../src/pool-quality-monitor';
import { RemoteSub2ApiReadClient } from '../../../../src/remote-sub2api-read-client';
import { audioRequestSql, isAudioRequest } from '../../../../src/scoring-error-policy';

// 通过正式只读 broker 执行真实 SQL，夹具 CTE 遮蔽业务表，绝不写入记录。
export async function verifyPoolQualityWindow(client: AdminHttpClient, config: AppConfig) {
  const fixture = (audio: boolean) => `WITH accounts AS (
    SELECT 1::bigint id,'fixture'::text name,'openai'::text platform,'apikey'::text type,
      '{"base_url":"https://fixture.example"}'::jsonb credentials,NULL::timestamptz deleted_at
  ), account_groups AS (SELECT 1::bigint account_id,2::bigint group_id),
  users AS (
    SELECT * FROM (VALUES (10::bigint,'fixture@example.test'::text,NULL::timestamptz),
      (20,'monitor-user@sub2api.platform-infra.local',NULL)) t(id,email,deleted_at)
  ), api_keys AS (
    SELECT * FROM (VALUES (1::bigint,10::bigint,NULL::timestamptz),(99,20,NULL)) t(id,user_id,deleted_at)
  ), usage_logs AS (
    SELECT id,request_id,at::timestamptz created_at,1::bigint account_id,10::bigint user_id,
      key::bigint api_key_id,true stream,ttft::bigint first_token_ms,2000::bigint duration_ms,
      model::text model,requested_model::text requested_model,upstream_model::text upstream_model
    FROM (VALUES
      (1,'text','2026-01-01T00:00:00Z',1,999,'gpt-6.1-sol',NULL,NULL),
      (2,'text','2026-01-01T00:10:00Z',1,500,'gpt-6.1-sol',NULL,NULL),
      (3,'recovered','2026-01-01T00:01:00Z',1,1000,'gpt-6.1-sol',NULL,NULL),
      (4,'probe','2026-01-01T00:20:00Z',99,999999,'gpt-6.1-sol',NULL,NULL),
      (5,'old','2026-01-01T00:00:00Z',1,999999,'gpt-6.1-sol',NULL,NULL),
      (6,'other-text','2026-01-01T00:04:00Z',1,1500,'audiovisual-text',NULL,NULL)
    ) t(id,request_id,at,key,ttft,model,requested_model,upstream_model)
    UNION ALL SELECT 100+n,'voice-success-'||n,'2026-01-01T00:30:00Z'::timestamptz,
      1,10,1,true,999999,999999,'gpt-6.1-sol',NULL,'AUDIO' FROM generate_series(1,1005) n WHERE ${audio}
  ), ops_error_logs AS (
    SELECT id,request_id,at::timestamptz created_at,1::bigint account_id,10::bigint user_id,
      2::bigint group_id,1::bigint api_key_id,true stream,NULL::bigint time_to_first_token_ms,
      2000::bigint duration_ms,'gpt-6.1-sol'::text model,NULL::text requested_model,NULL::text upstream_model,
      '/v1/responses'::text inbound_endpoint,NULL::text upstream_endpoint,'upstream'::text error_phase,
      'upstream_error'::text error_type,status::int status_code,status::int upstream_status_code,
      false is_business_limited,message::text error_message,NULL::text error_body,
      NULL::text upstream_error_message,NULL::text upstream_error_detail
    FROM (VALUES
      (1,'recovered','2026-01-01T00:05:00Z',503,'upstream failed'),
      (2,'text-fail','2026-01-01T00:09:00Z',503,'upstream failed'),
      (3,'text-fail','2026-01-01T00:08:00Z',503,'upstream failed'),
      (4,'balance','2026-01-01T00:02:00Z',403,'insufficient_balance')
    ) t(id,request_id,at,status,message)
    UNION ALL SELECT 100+n,'voice-error-'||n,'2026-01-01T00:30:00Z'::timestamptz,
      1,10,2,1,true,NULL,999999,'gpt-6.1-sol','VOICE',NULL,'/v1/responses',NULL,
      'upstream','upstream_error',503,503,false,'upstream failed',NULL,NULL,NULL
    FROM generate_series(1,1005) n WHERE ${audio}
  ), ops_system_logs AS (
    SELECT * FROM (VALUES ('recovered'::text,'openai.upstream_failover_switching'::text),
      ('voice-error-1','openai.upstream_failover_switching')) t(request_id,message)
  ), `;
  const reads = (audio: boolean) => new RemoteSub2ApiReadClient({
    sub2ApiRead: (request) => client.sub2ApiRead({ ...request,
      key: `pool-quality-fixture:${crypto.randomUUID()}`, kind: 'pool-quality.fixture', priority: 'manual',
      sql: fixture(audio) + request.sql.replace(/^\s*WITH\s/u, ''),
      parameters: [5, ...request.parameters.slice(1)],
    }),
  });
  const sampledAt = '2026-01-01T01:00:00Z';
  const baseline = await collectPoolQualitySample(config, reads(false), sampledAt);
  const withAudio = await collectPoolQualitySample(config, reads(true), sampledAt);
  const errors = await collectPoolQualityErrors(config, reads(true), { sampledAt, page: 1, pageSize: 20, filter: 'all' });
  const variants = [
    { requested_model: 'AUDIO', model: 'gpt-6.1-sol', upstream_model: null, inbound_endpoint: '/v1/responses' },
    { requested_model: null, model: 'tts-1', upstream_model: 'normal', inbound_endpoint: null },
    { requested_model: 'normal', model: 'normal', upstream_model: 'WHISPER-1', inbound_endpoint: null },
    { requested_model: 'au', model: 'dio', upstream_model: 'audiovisual-text', inbound_endpoint: '/v1/responses' },
    { requested_model: '', model: 'gpt-6.1-sol', upstream_model: '', inbound_endpoint: '/V1/AUDIO/speech?x=1' },
  ];
  const matrix = await client.sub2ApiRead<typeof variants[number] & { audio: boolean }>({
    key: `pool-quality-fixture:${crypto.randomUUID()}`, kind: 'pool-quality.fixture', priority: 'manual', cacheMode: 'bypass-cache',
    sql: `WITH c AS (SELECT * FROM jsonb_to_recordset($1::jsonb)
      AS x(requested_model text,model text,upstream_model text,inbound_endpoint text))
      SELECT c.*, ${audioRequestSql('c', true)} AS audio FROM c`, parameters: [JSON.stringify(variants)],
  });
  const checks = {
    audioCannotChangePoolScore: JSON.stringify(baseline) === JSON.stringify(withAudio),
    eligibleWindowFilled: withAudio.rawCallCount === 5,
    deduplicatedTextSuccess: withAudio.rawSuccessRequests === 3,
    textFailureRetained: withAudio.rawFailureRequests === 1,
    onlyTextFailover: withAudio.rawFailoverRequests === 1 && withAudio.rawFailoverRecovered === 1,
    audioLatencyExcluded: withAudio.ttftP95Ms === 1500,
    errorWindowMatchesScore: errors.pagination.total === 2,
    modelBoundaryParity: matrix.rows.length === variants.length && matrix.rows.every((row) =>
      row.audio === isAudioRequest([row.requested_model, row.model, row.upstream_model], row.inbound_endpoint)),
  };
  return { ok: Object.values(checks).every(Boolean), checks, mutation: false, valuesPrinted: false };
}
