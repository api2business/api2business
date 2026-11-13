import { observedRateEventsSql } from "./observability-sql";

// This query deliberately avoids error logs, SLO percentiles and user joins.
// Cost evidence remains independent when service-quality diagnostics are slow.
export const dailyCostSql = `WITH ${observedRateEventsSql}, probe_keys AS (
  SELECT k.id FROM api_keys k LEFT JOIN users u ON u.id=k.user_id
  WHERE u.email='monitor-user@sub2api.platform-infra.local'
    OR LOWER(COALESCE(k.name,'')) LIKE 'api2business-probe-%'
), usage AS MATERIALIZED (
  SELECT u.account_id,u.created_at,u.actual_cost,u.rate_multiplier,
    (u.created_at AT TIME ZONE $4)::date::text AS day,
    u.created_at >= $2::timestamptz - INTERVAL '24 hours' AS recent_24h
  FROM usage_logs u LEFT JOIN probe_keys p ON p.id=u.api_key_id
  LEFT JOIN groups g ON g.id=u.group_id
  WHERE u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz
    AND p.id IS NULL AND LOWER(COALESCE(g.name,'')) NOT LIKE 'api2business-probe-%'
), rate_intervals AS MATERIALIZED (
  -- Resolve rate history as bounded intervals instead of a per-row LATERAL.
  -- A million in-window usage rows made the correlated lookup alone exceed
  -- the 15s read budget on the seven-day costs report.
  SELECT account_id,at,rate_cny,wallet_rate_cny,
    LEAD(at) OVER (PARTITION BY account_id ORDER BY at,rate_cny) AS next_at
  FROM rate_events
), first_rates AS MATERIALIZED (
  SELECT account_id,MIN(at) AS first_at FROM rate_intervals GROUP BY account_id
), matched_usage AS MATERIALIZED (
  -- Drive from the small rate-interval set and use the usage_logs
  -- (account_id,created_at) index for each interval. Driving from one million
  -- usage rows made the range join exceed the 15s read budget.
  SELECT u.*,COALESCE(rate.rate_cny,u.rate_multiplier*rate.wallet_rate_cny) AS rate_cny,rate.at AS rate_at
  FROM rate_intervals rate
  JOIN LATERAL (
    SELECT u.account_id,u.created_at,u.actual_cost,u.rate_multiplier,u.day,u.recent_24h
    FROM usage u
    WHERE u.account_id=rate.account_id
      AND u.created_at>=rate.at
      AND (rate.next_at IS NULL OR u.created_at<rate.next_at)
  ) u ON true
), unmatched_usage AS MATERIALIZED (
  -- Only usage before an account's first observed rate is unmatched; every
  -- later row is covered by the final open-ended interval.
  SELECT u.*,NULL::double precision AS rate_cny,NULL::timestamptz AS rate_at
  FROM usage u LEFT JOIN first_rates f ON f.account_id=u.account_id
  WHERE f.first_at IS NULL OR u.created_at<f.first_at
), cost_usage AS (
  SELECT * FROM matched_usage UNION ALL SELECT * FROM unmatched_usage
), costs AS (
  SELECT day,account_id,recent_24h,COUNT(*)::int AS records,
    COUNT(*) FILTER (WHERE actual_cost>=0 AND rate_multiplier>0 AND rate_cny IS NULL)::int AS valid_records,
    COUNT(*) FILTER (WHERE actual_cost>=0 AND rate_multiplier>0 AND rate_cny>0)::int AS historical_records,
    SUM(actual_cost / NULLIF(rate_multiplier,0)*rate_cny) FILTER (WHERE actual_cost>=0 AND rate_multiplier>0 AND rate_cny>0)::float8 AS historical_cost_cny,
    SUM(actual_cost / NULLIF(rate_multiplier,0)) FILTER (WHERE actual_cost>=0 AND rate_multiplier>0 AND rate_cny IS NULL)::float8 AS normalized_cost,
    MIN(created_at) AS first_at,MIN(rate_at) AS first_rate_at,MAX(rate_at) AS last_rate_at
  FROM cost_usage GROUP BY day,account_id,recent_24h
), account_rows AS (
  -- An OR over the account filter makes the planner give up on the accounts
  -- indexes and fall back to a full scan joined to every cost row. Split it
  -- into two indexable branches and de-duplicate with UNION.
  SELECT id,name,platform,type,RTRIM(COALESCE(credentials->>'base_url',''),'/') AS base_url,
    deleted_at IS NULL AS active,status,schedulable,priority
  FROM accounts WHERE deleted_at IS NULL AND type='apikey'
  UNION
  SELECT a.id,a.name,a.platform,a.type,RTRIM(COALESCE(a.credentials->>'base_url',''),'/'),
    a.deleted_at IS NULL,a.status,a.schedulable,a.priority
  FROM accounts a WHERE a.id IN (SELECT account_id FROM costs)
)
SELECT jsonb_build_object(
  'costAccounts',COALESCE((SELECT jsonb_agg(c) FROM costs c),'[]'::jsonb),
  'accounts',COALESCE((SELECT jsonb_agg(a) FROM account_rows a),'[]'::jsonb)
) AS facts`;

type Row = Record<string, any>;

export function dailyWalletCosts(costAccounts: Row[], accountFacts: Row[], walletFacts: Row[]): Row[] {
  const byId = new Map(accountFacts.map(account => [Number(account.id),account]));
  return walletFacts.map(wallet => {
    const days = new Map<string, Row>();
    const matched = costAccounts.filter(a => a.walletKey === wallet.walletKey);
    for (const account of matched) {
      const day = String(account.day);
      const item = days.get(day) ?? { day,records:0,knownRecords:0,missingRecords:0,knownCostCny:0 };
      item.records += account.records; item.knownRecords += account.knownRecords;
      item.missingRecords += account.missingRecords; item.knownCostCny += account.knownCostCny ?? 0;
      days.set(day,item);
    }
    const recent = matched.filter(a => a.recent24Hours).reduce((total, account) => ({
      records:total.records+account.records,knownRecords:total.knownRecords+account.knownRecords,
      missingRecords:total.missingRecords+account.missingRecords,knownCostCny:total.knownCostCny+(account.knownCostCny ?? 0),
    }), {records:0,knownRecords:0,missingRecords:0,knownCostCny:0});
    return {...wallet,recent24Hours:{...recent,complete:recent.records===recent.knownRecords,
      totalCostCny:recent.records===recent.knownRecords?recent.knownCostCny:null},accounts:wallet.accountIds.map((id:number) => {
      const account=byId.get(id);
      return {accountId:id,name:account?.name,platform:account?.platform,status:account?.status,
        schedulable:account?.schedulable,priority:account?.priority};
    }),daily:[...days.values()].sort((a,b)=>a.day.localeCompare(b.day)).map(day=>({...day,
      complete:day.records===day.knownRecords,
      totalCostCny:day.records===day.knownRecords?day.knownCostCny:null,
    }))};
  });
}
