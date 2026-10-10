import { observedRateEventsSql } from "./observability-sql";

// This query deliberately avoids error logs, SLO percentiles and user joins.
// Cost evidence remains independent when service-quality diagnostics are slow.
export const dailyCostSql = `WITH ${observedRateEventsSql}, probe_keys AS (
  SELECT k.id FROM api_keys k LEFT JOIN users u ON u.id=k.user_id
  WHERE u.email='monitor-user@sub2api.platform-infra.local'
    OR LOWER(COALESCE(k.name,'')) LIKE 'api2business-probe-%'
), usage AS (
  SELECT u.account_id,u.created_at,u.actual_cost,u.rate_multiplier,
    (u.created_at AT TIME ZONE $4)::date::text AS day
  FROM usage_logs u LEFT JOIN probe_keys p ON p.id=u.api_key_id
  LEFT JOIN groups g ON g.id=u.group_id
  WHERE u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz
    AND p.id IS NULL AND LOWER(COALESCE(g.name,'')) NOT LIKE 'api2business-probe-%'
), cost_usage AS (
  SELECT u.*,rate.rate_cny,rate.at AS rate_at FROM usage u
  LEFT JOIN LATERAL (
    SELECT r.rate_cny,r.at FROM rate_events r WHERE r.account_id=u.account_id AND r.at<=u.created_at
    ORDER BY r.at DESC LIMIT 1
  ) rate ON true
), costs AS (
  SELECT day,account_id,COUNT(*)::int AS records,
    COUNT(*) FILTER (WHERE actual_cost>=0 AND rate_multiplier>0 AND rate_cny IS NULL)::int AS valid_records,
    COUNT(*) FILTER (WHERE actual_cost>=0 AND rate_multiplier>0 AND rate_cny>0)::int AS historical_records,
    SUM(actual_cost / NULLIF(rate_multiplier,0)*rate_cny) FILTER (WHERE actual_cost>=0 AND rate_multiplier>0 AND rate_cny>0)::float8 AS historical_cost_cny,
    SUM(actual_cost / NULLIF(rate_multiplier,0)) FILTER (WHERE actual_cost>=0 AND rate_multiplier>0 AND rate_cny IS NULL)::float8 AS normalized_cost,
    MIN(created_at) AS first_at,MIN(rate_at) AS first_rate_at,MAX(rate_at) AS last_rate_at
  FROM cost_usage GROUP BY day,account_id
), account_rows AS (
  SELECT id,name,platform,type,RTRIM(COALESCE(credentials->>'base_url',''),'/') AS base_url,
    deleted_at IS NULL AS active,status,schedulable,priority
  FROM accounts WHERE (deleted_at IS NULL AND type='apikey') OR id IN (SELECT account_id FROM costs)
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
    for (const account of costAccounts.filter(a => a.walletKey === wallet.walletKey)) {
      const day = String(account.day);
      const item = days.get(day) ?? { day,records:0,knownRecords:0,missingRecords:0,knownCostCny:0 };
      item.records += account.records; item.knownRecords += account.knownRecords;
      item.missingRecords += account.missingRecords; item.knownCostCny += account.knownCostCny ?? 0;
      days.set(day,item);
    }
    return {...wallet,accounts:wallet.accountIds.map((id:number) => {
      const account=byId.get(id);
      return {accountId:id,name:account?.name,platform:account?.platform,status:account?.status,
        schedulable:account?.schedulable,priority:account?.priority};
    }),daily:[...days.values()].sort((a,b)=>a.day.localeCompare(b.day)).map(day=>({...day,
      complete:day.records===day.knownRecords,
      totalCostCny:day.records===day.knownRecords?day.knownCostCny:null,
    }))};
  });
}
