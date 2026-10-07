// Both event sources use the same half-open window. No recent-N truncation.
export const observabilitySql = `
WITH rate_events AS (
  SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(account_id bigint,at timestamptz,rate_cny double precision)
), probe_keys AS (
  SELECT k.id FROM api_keys k LEFT JOIN users u ON u.id=k.user_id
  WHERE u.email='monitor-user@sub2api.platform-infra.local'
    OR LOWER(COALESCE(k.name,'')) LIKE 'api2business-probe-%'
), usage_source AS (
  SELECT u.*, (p.id IS NOT NULL OR LOWER(COALESCE(g.name,'')) LIKE 'api2business-probe-%') AS probe
  FROM usage_logs u LEFT JOIN probe_keys p ON p.id=u.api_key_id
  LEFT JOIN groups g ON g.id=u.group_id
  WHERE u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz
), error_source AS (
  SELECT o.*, (p.id IS NOT NULL OR LOWER(COALESCE(g.name,'')) LIKE 'api2business-probe-%') AS probe
  FROM ops_error_logs o LEFT JOIN probe_keys p ON p.id=o.api_key_id
  LEFT JOIN groups g ON g.id=o.group_id
  WHERE o.created_at >= $1::timestamptz AND o.created_at < $2::timestamptz
), usage AS (SELECT * FROM usage_source WHERE NOT probe),
errors AS (
  SELECT * FROM error_source WHERE NOT probe
    AND LOWER(COALESCE(error_type,'')) <> 'failover_event'
    AND NOT (COALESCE(status_code,upstream_status_code,0) BETWEEN 200 AND 399)
), success AS (
  SELECT DISTINCT ON (request_id) request_id, account_id, stream, first_token_ms
  FROM usage WHERE NULLIF(TRIM(request_id),'') IS NOT NULL
  ORDER BY request_id,created_at DESC,id DESC
), failure AS (
  SELECT DISTINCT ON (e.request_id) e.request_id,e.account_id,e.error_phase,e.error_type,
    e.status_code,e.upstream_status_code,e.network_error_type,
    CASE
      WHEN COALESCE(e.is_business_limited,false) OR e.error_phase='business' THEN 'business_limit'
      WHEN e.error_phase='client' THEN 'client_input'
      WHEN e.status_code=429 OR e.upstream_status_code=429 THEN 'rate_limit'
      WHEN e.status_code IN (502,503,504,524) OR e.upstream_status_code IN (502,503,504,524) THEN 'gateway_unavailable'
      WHEN LOWER(CONCAT_WS(' ',e.network_error_type,e.error_type)) LIKE '%timeout%' THEN 'timeout'
      WHEN e.status_code IN (401,403) OR e.upstream_status_code IN (401,403) OR e.error_phase='auth' THEN 'authentication'
      WHEN LOWER(COALESCE(e.error_type,'')) LIKE '%stream%' THEN 'stream_interrupted'
      WHEN e.error_phase='upstream' THEN 'upstream_other'
      WHEN e.error_phase IN ('internal','network') THEN 'infrastructure_other'
      ELSE 'unknown' END AS family
  FROM errors e WHERE NULLIF(TRIM(e.request_id),'') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM success s WHERE s.request_id=e.request_id)
  ORDER BY e.request_id,e.created_at DESC,e.id DESC
), cost_usage AS (
  SELECT u.*, rate.rate_cny,rate.at AS rate_at FROM usage u
  LEFT JOIN LATERAL (
    SELECT r.rate_cny,r.at FROM rate_events r WHERE r.account_id=u.account_id AND r.at<=u.created_at
    ORDER BY r.at DESC LIMIT 1
  ) rate ON true
), cost AS (
  SELECT account_id,COUNT(*)::int AS records,
    COUNT(*) FILTER (WHERE actual_cost IS NOT NULL AND actual_cost>=0 AND rate_multiplier>0 AND rate_cny IS NULL)::int AS valid_records,
    COUNT(*) FILTER (WHERE actual_cost>=0 AND rate_multiplier>0 AND rate_cny>0)::int AS historical_records,
    SUM(actual_cost / NULLIF(rate_multiplier,0)*rate_cny) FILTER (WHERE actual_cost>=0 AND rate_multiplier>0 AND rate_cny>0)::float8 AS historical_cost_cny,
    MIN(rate_at) AS first_rate_at,MAX(rate_at) AS last_rate_at,
    SUM(actual_cost / NULLIF(rate_multiplier,0)) FILTER (WHERE actual_cost>=0 AND rate_multiplier>0 AND rate_cny IS NULL)::float8 AS normalized_cost,
    MIN(created_at) AS first_at
  FROM cost_usage GROUP BY account_id
), account_rows AS (
  SELECT id,platform,type,RTRIM(COALESCE(credentials->>'base_url',''),'/') AS base_url,
    deleted_at IS NULL AS active
  FROM accounts WHERE (deleted_at IS NULL AND type='apikey') OR id IN (SELECT account_id FROM cost)
), platform_facts AS (
 SELECT COALESCE(a.platform,'unknown') AS platform,COUNT(*)::int AS requests,
   COUNT(*) FILTER (WHERE r.ok)::int AS succeeded,
   COUNT(*) FILTER (WHERE NOT r.ok)::int AS failed,
   COUNT(*) FILTER (WHERE r.ok AND r.stream)::int AS streaming,
   COUNT(*) FILTER (WHERE r.ok AND r.stream AND r.first_token_ms>=0)::int AS ttft_known,
   percentile_cont(0.95) WITHIN GROUP (ORDER BY r.first_token_ms)
     FILTER (WHERE r.ok AND r.stream AND r.first_token_ms>=0) AS ttft_p95_ms
 FROM (
   SELECT account_id,true AS ok,stream,first_token_ms FROM success
   UNION ALL SELECT account_id,false,false,NULL FROM failure
 ) r LEFT JOIN accounts a ON a.id=r.account_id GROUP BY COALESCE(a.platform,'unknown')
)
SELECT jsonb_build_object(
  'succeeded',(SELECT COUNT(*) FROM success),
  'failed',(SELECT COUNT(*) FROM failure),
  'streaming',(SELECT COUNT(*) FROM success WHERE stream),
  'ttftKnown',(SELECT COUNT(*) FROM success WHERE stream AND first_token_ms>=0),
  'ttftP95Ms',(SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms) FROM success WHERE stream AND first_token_ms>=0),
  'missingRequestIdRecords',(SELECT COUNT(*) FROM usage WHERE NULLIF(TRIM(request_id),'') IS NULL)
    +(SELECT COUNT(*) FROM errors WHERE NULLIF(TRIM(request_id),'') IS NULL),
  'excludedProbeRecords',(SELECT COUNT(*) FROM usage_source WHERE probe)+(SELECT COUNT(*) FROM error_source WHERE probe),
  'recoveredRequests',(SELECT COUNT(DISTINCT e.request_id) FROM errors e JOIN success s USING(request_id)),
  'errorFamilies',COALESCE((SELECT jsonb_agg(t) FROM (SELECT family,COUNT(*)::int AS requests FROM failure GROUP BY family ORDER BY COUNT(*) DESC) t),'[]'::jsonb),
  'unknownExamples',COALESCE((SELECT jsonb_agg(t) FROM (SELECT request_id,error_phase,error_type,status_code,upstream_status_code,network_error_type FROM failure WHERE family='unknown' ORDER BY request_id LIMIT 10) t),'[]'::jsonb),
  'platforms',COALESCE((SELECT jsonb_agg(t) FROM platform_facts t),'[]'::jsonb),
  'costAccounts',COALESCE((SELECT jsonb_agg(t) FROM cost t),'[]'::jsonb),
  'accounts',COALESCE((SELECT jsonb_agg(t) FROM account_rows t),'[]'::jsonb)
) AS facts`;
