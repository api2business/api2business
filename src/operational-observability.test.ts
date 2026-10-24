import { expect,test } from 'bun:test';
import { observationWindow,observationPath,slo,walletGovernance,costGovernance,observerCoverage } from './operational-observability';
import { parseObservabilityConfig } from './observability-config';
import { authoritativeUsageBalance } from './operations-store';
import { compactObservation,checkObservability } from '../skills/api2business/scripts/src/observability';
import { observabilitySql } from './observability-sql';
import type { AppConfig } from './config';
import type { AdminHttpClient } from './admin-http-client';
import { dailyWalletCosts } from './observability-costs';
const settings={sub2apiSuccessPercent:95,sub2apiTtftP95Ms:30000,api2businessNon5xxPercent:99.9,api2businessLatencyP95Ms:3000,walletFreshnessSeconds:3600,retentionDays:30};
const config={observability:settings,sub2api:{newApiCredentials:[{baseUrl:'https://alias.example',walletKey:'https://wallet.example'}]}} as AppConfig;
const at='2026-10-07T04:00:00.000Z';
const account=(id:number,url='https://wallet.example')=>({id,base_url:url,active:true,type:'apikey',platform:'openai'});
const cache=(id:number,remaining:number|null,sourceAt='2026-10-07T03:30:00.000Z')=>({account_id:id,queried_at:sourceAt,last_success_at:sourceAt,last_success_result:{ok:true,quota:{remaining,unit:'USD'},billingMultiplier:{value:0.5,observedAt:'2026-10-07T00:00:00.000Z'}},result:{ok:false}});
test('daily wallet costs retain usable partial evidence without inventing complete totals',()=>{
 const wallets=walletGovernance([account(1),account(2,'https://alias.example')],[cache(1,5)],config,at).wallets;
 const result=dailyWalletCosts([
  {accountId:1,walletKey:'https://wallet.example',day:'2026-10-06',recent24Hours:false,records:10,knownRecords:8,missingRecords:2,knownCostCny:20},
  {accountId:2,walletKey:'https://wallet.example',day:'2026-10-06',recent24Hours:true,records:2,knownRecords:2,missingRecords:0,knownCostCny:3},
  {accountId:1,walletKey:'https://wallet.example',day:'2026-10-07',recent24Hours:true,records:1,knownRecords:1,missingRecords:0,knownCostCny:0},
 ],[account(1),account(2)],wallets);
 expect(result).toHaveLength(1);
 expect(result[0]?.recent24Hours).toEqual({records:3,knownRecords:3,missingRecords:0,knownCostCny:3,complete:true,totalCostCny:3});
 expect(result[0]?.daily).toEqual([
  {day:'2026-10-06',records:12,knownRecords:10,missingRecords:2,knownCostCny:23,complete:false,totalCostCny:null},
  {day:'2026-10-07',records:1,knownRecords:1,missingRecords:0,knownCostCny:0,complete:true,totalCostCny:0},
 ]);
});
test('fixed window is half-open and never silently accepts a partial or future window',()=>{
 expect(observationWindow(null,null,Date.parse(at))).toMatchObject({start:'2026-10-07T02:00:00.000Z',end:at,seconds:7200});
 expect(()=>observationWindow(at,null)).toThrow();
 expect(()=>observationWindow(at,'2040-01-01')).toThrow();
});
test('30-second TTFT target and incomplete or empty evidence remain distinct',()=>{
 expect(parseObservabilityConfig(settings)?.sub2apiTtftP95Ms).toBe(30000);
 expect(slo(30000,30000,'max').status).toBe('met');
 expect(slo(30001,30000,'max').status).toBe('missed');
 expect(slo(null,30000,'max').status).toBe('insufficient_data');
 expect(slo(100,99,'min',false).status).toBe('insufficient_data');
 expect(()=>parseObservabilityConfig({...settings,sub2apiTtftP95Ms:NaN})).toThrow();
});
test('observability report keeps user balance and TTFT attribution for diagnosis',()=>{
 expect(observabilitySql).toContain('api_user_email');
 expect(observabilitySql).toContain('businessLimitBreakdown');
 expect(observabilitySql).toContain('excludedBusinessLimitRecords');
 expect(observabilitySql).toContain('e.api_user_id IS NOT NULL');
 expect(observabilitySql).toContain('NOT EXISTS (SELECT 1 FROM customer_billing b WHERE b.request_id=e.request_id)');
 expect(observabilitySql).toContain('%api_key_quota_exhausted%');
 expect(observabilitySql).toContain('%api key 额度已用完%');
 expect(observabilitySql).toContain('ttftBreakdown');
 expect(observabilitySql).toContain('percentile_cont(0.95) WITHIN GROUP (ORDER BY s.first_token_ms)');
});
test('explicit upstream failures survive a recorded HTTP 200 without overriding exact success',()=>{
 expect(observabilitySql).toContain('OR COALESCE(upstream_status_code,0)>=400');
 expect(observabilitySql).toContain("LOWER(COALESCE(error_type,'')) <> 'failover_event'");
 expect(observabilitySql).toContain('NOT EXISTS (SELECT 1 FROM success s WHERE (s.request_id = e.request_id');
});
test('native terminal policy refusals do not become successes through zero-token usage',()=>{
 expect(observabilitySql).toContain("OR (error_phase='request' AND error_type='cyber_policy')");
 expect(observabilitySql).toContain('u.request_id = terminal.request_id');
 expect(observabilitySql).toContain("terminal.error_phase='request' AND terminal.error_type='cyber_policy'");
 // Attempt errors still permit a later exact success; only request-final events override it.
 expect(observabilitySql).not.toContain("terminal.error_phase='upstream'");
});
test('observer failures are scoped to the half-open window without erasing legacy uncertainty',()=>{
 const start='2026-10-07T02:00:00Z',end='2026-10-07T04:00:00Z';
 const base={started_at:start,last_seen_at:end,failed_writes:3};
 expect(observerCoverage([{...base,failed_write_times:['2026-10-07T01:59:59Z',end]}],start,end))
  .toMatchObject({failedWrites:0,lifetimeFailedWrites:3,unlocatedFailedWrites:0,complete:true});
 expect(observerCoverage([{...base,failed_write_times:[start]}],start,end))
  .toMatchObject({failedWrites:1,complete:false});
 expect(observerCoverage([{...base,failed_write_times:JSON.stringify(['2026-10-07T01:59:59Z',end])}],start,end))
  .toMatchObject({failedWrites:0,unlocatedFailedWrites:0,complete:true});
 expect(observerCoverage([{...base,failed_write_times:JSON.stringify([start])}],start,end))
  .toMatchObject({failedWrites:1,complete:false});
 expect(observerCoverage([{...base,failed_write_times:'invalid-json'}],start,end))
  .toMatchObject({unlocatedFailedWrites:3,complete:false});
 expect(observerCoverage([base],start,end))
  .toMatchObject({unlocatedFailedWrites:3,complete:false});
});
test('shared wallets count once, preserve source and distinguish missing from zero',()=>{
 const result=walletGovernance([account(525),account(1500,'https://alias.example'),account(3,'https://missing.example'),account(4,'https://zero.example')],[cache(525,10),cache(1500,0),cache(3,null),cache(4,0)],config,at);
 expect(result).toMatchObject({walletCount:3,accountCount:4,sharedWallets:1,unknownWallets:1,knownBalanceUsd:10});
 expect(result.wallets.find(w=>w.walletKey==='https://wallet.example')).toMatchObject({sourceAccountId:525,remainingUsd:10,conflictingBalances:true,lastAttemptOk:false});
 expect(result.wallets.find(w=>w.walletKey==='https://zero.example')?.state).toBe('zero');
 expect(authoritativeUsageBalance({ok:true,quota:{unit:'USD',remaining:null}})).toBeFalse();
});
test('stale successful balance stays visible and marked stale after failed attempts',()=>{
 const result=walletGovernance([account(1)],[cache(1,12,'2026-10-07T00:00:00.000Z')],config,at);
 expect(result.wallets[0]).toMatchObject({remainingUsd:12,freshness:'stale',lastAttemptOk:false});
});
test('normal wallet consumption at different observation times is not a conflict despite batch cache timestamps',()=>{
 const rows=[cache(1,10),cache(2,9)].map((item,i)=>({...item,last_success_at:at,
  last_success_result:{...item.last_success_result,queriedAt:`2026-10-07T03:3${i}:00.000Z`}}));
 for(const ordered of [rows,[...rows].reverse()]) {
  const result=walletGovernance([account(1),account(2)],ordered,config,at);
  expect(result.wallets[0]).toMatchObject({remainingUsd:9,sourceAt:'2026-10-07T03:31:00.000Z',
   sourceAccountId:2,conflictingBalances:false,supersededBalanceObservationCount:1});
 }
});
test('shared source metadata survives later token reads and failed attempts without refreshing the balance',()=>{
 const observedAt='2026-10-07T00:00:00.000Z';
 const rows=[cache(1,10),cache(2,10)].map(item=>({...item,last_success_at:at,
  last_success_result:{...item.last_success_result,queriedAt:at,walletBalance:{observedAt,sourceAccountId:1}}}));
 const wallet=walletGovernance([account(1),account(2)],rows,config,at).wallets[0];
 expect(wallet).toMatchObject({sourceAt:observedAt,sourceAccountId:1,conflictingBalances:false,freshness:'stale',lastAttemptOk:false});
 expect(wallet.balanceObservations).toHaveLength(1);
});
test('actual cost uses evidenced supplier and currency rates; historical gaps never become zero',()=>{
 const facts={accounts:[account(1),account(2)],costAccounts:[{account_id:1,records:3,valid_records:2,normalized_cost:10,first_at:'2026-10-07T02:00:00.000Z'},{account_id:2,records:1,valid_records:1,normalized_cost:50,first_at:'2026-10-07T02:00:00.000Z'}]};
 const result=costGovernance(facts,[cache(1,10)],config,at,{defaultCnyPerApiUsd:2,walletCnyPerApiUsd:{}},'2026-01-01T00:00:00.000Z');
 expect(result).toMatchObject({records:4,knownRecords:2,knownCostCny:10,totalCostCny:null,complete:false,coveragePercent:50});
 expect(result.accounts[1]?.reason).toBe('provider_rate_missing');
 const historical=costGovernance(facts,[cache(1,10)],config,'2025-12-31',{defaultCnyPerApiUsd:1,walletCnyPerApiUsd:{}},'2026-01-01');
 expect(historical.knownRecords).toBe(0);
 expect(historical.accounts[0]?.reason).toBe('historical_provider_rate_missing');
});
test('non API-key usage is explicitly out of scope instead of missing reconciliation',()=>{
 const facts={accounts:[{...account(1521),type:'oauth',platform:'antigravity'}],costAccounts:[{account_id:1521,records:1405,valid_records:1405,normalized_cost:17.70914985,first_at:'2026-10-07T02:00:00.000Z'}]};
 const result=costGovernance(facts,[],config,at,{defaultCnyPerApiUsd:1,walletCnyPerApiUsd:{}},'2026-01-01T00:00:00.000Z');
 expect(result).toMatchObject({records:1405,inScopeRecords:0,outOfScopeRecords:1405,knownRecords:0,missingRecords:0,coveragePercent:null,complete:false});
 expect(result.accounts[0]).toMatchObject({accountType:'oauth',inScope:false,accountingStatus:'not_applicable',missingRecords:0,outOfScopeRecords:1405,reason:'non_apikey_not_in_scope'});
});
test('instrumentation excludes worker, login and itself and never stores dynamic paths',()=>{
 for(const path of ['/health','/api/login','/api/internal/execute-worker-operation','/api/observability/report','/api/admin/read-status']) expect(observationPath(path)).toBeNull();
 expect(observationPath('/api/upstreams/secret-looking-id/delete')).toBe('/api/upstreams/:operation');
 expect(observationPath('/api/v2/upstream-scheduling/snapshot')).toBe('/api/v2/upstream-scheduling/snapshot');
 expect(observationPath('/api/v2/upstream-scheduling/model-sync/plan')).toBe('/api/v2/upstream-scheduling/model-sync/plan');
 expect(observationPath('/api/v2/upstream-scheduling/secret-looking-id')).toBe('/api/v2/:operation');
 expect(observationPath('/api/v2/upstream-scheduling/snapshot?scope=secret')).toBe('/api/v2/:operation');
});
test('new deployment, restart gaps and write loss cannot claim a complete SLO window',()=>{
 const start='2026-10-07T02:00:00Z',end='2026-10-07T04:00:00Z';
 expect(observerCoverage([{started_at:'2026-10-07T03:00:00Z',last_seen_at:end}],start,end)).toMatchObject({coveredSeconds:3600,complete:false});
 expect(observerCoverage([{started_at:start,last_seen_at:end}],start,end).complete).toBeTrue();
 expect(observerCoverage([{started_at:start,last_seen_at:'2026-10-07T03:00:00Z'},{started_at:'2026-10-07T03:01:00Z',last_seen_at:end}],start,end).complete).toBeFalse();
 expect(observerCoverage([{started_at:start,last_seen_at:end,failed_writes:1}],start,end).complete).toBeFalse();
});
test('CLI bounds details and samples continue after an earlier 502',async()=>{
 const compact=compactObservation({id:'x',wallets:{wallets:Array.from({length:12},(_,i)=>i)}},false);
 expect(compact.wallets.wallets).toMatchObject({total:12,omitted:2});
 let calls=0;
 const client={readStatus:async()=>({ok:true,readExecutor:{observedAt:at}}),upstreamQuotaSummary:async()=>{if(++calls===1)throw new Error('HTTP 502');return{ok:true}},upstreamRechargeCandidates:async()=>({ok:true})} as unknown as AdminHttpClient;
 const result=await checkObservability(client,2);
 expect(result.ok).toBeFalse();expect(result.samples).toHaveLength(6);
 expect(result.samples[1]?.error).toContain('502');expect(result.samples[4]?.ok).toBeTrue();
});

test('persisted historical rates cover cost without retroactively applying current policy',()=>{
 const facts={accounts:[account(1)],costAccounts:[{account_id:1,records:2,valid_records:0,historical_records:2,historical_cost_cny:1.5,first_rate_at:'2026-10-07T01:00:00Z',last_rate_at:'2026-10-07T03:00:00Z',first_at:'2026-10-07T02:00:00Z'}]};
 const result=costGovernance(facts,[],config,at,{defaultCnyPerApiUsd:99,walletCnyPerApiUsd:{}},'2026-10-07T05:00:00Z');
 expect(result).toMatchObject({complete:true,totalCostCny:1.5,knownRecords:2,coveragePercent:100});
 expect(result.accounts[0]?.reason).toBeNull();
});


test('success SLO requires strictly above 95 without rounding; historical comparisons stay explicit',()=>{
 expect(slo(94.9999,95,'above')).toMatchObject({comparison:'gt',status:'missed'});
 expect(slo(95,95,'above')).toMatchObject({comparison:'gt',status:'missed'});
 expect(slo(95.0001,95,'above')).toMatchObject({comparison:'gt',status:'met'});
 expect(slo(95.16,95,'above').status).toBe('met');
 expect(slo(null,95,'above').status).toBe('insufficient_data');
 expect(slo(100,95,'above',false).status).toBe('insufficient_data');
 expect(slo(99.9,99.9,'min')).toMatchObject({comparison:'gte',status:'met'});
 expect(slo(30000,30000,'max')).toMatchObject({comparison:'lte',status:'met'});
});
