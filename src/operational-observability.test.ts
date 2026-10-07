import { expect,test } from 'bun:test';
import { observationWindow,observationPath,slo,walletGovernance,costGovernance,observerCoverage } from './operational-observability';
import { parseObservabilityConfig } from './observability-config';
import { authoritativeUsageBalance } from './operations-store';
import { compactObservation,checkObservability } from '../skills/api2business/scripts/src/observability';
import type { AppConfig } from './config';
import type { AdminHttpClient } from './admin-http-client';
const settings={sub2apiSuccessPercent:99,sub2apiTtftP95Ms:30000,api2businessNon5xxPercent:99.9,api2businessLatencyP95Ms:3000,walletFreshnessSeconds:3600,retentionDays:30};
const config={observability:settings,sub2api:{newApiCredentials:[{baseUrl:'https://alias.example',walletKey:'https://wallet.example'}]}} as AppConfig;
const at='2026-10-07T04:00:00.000Z';
const account=(id:number,url='https://wallet.example')=>({id,base_url:url,active:true,type:'apikey',platform:'openai'});
const cache=(id:number,remaining:number|null,sourceAt='2026-10-07T03:30:00.000Z')=>({account_id:id,queried_at:sourceAt,last_success_at:sourceAt,last_success_result:{ok:true,quota:{remaining,unit:'USD'},billingMultiplier:{value:0.5,observedAt:'2026-10-07T00:00:00.000Z'}},result:{ok:false}});
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
test('actual cost uses evidenced supplier and currency rates; historical gaps never become zero',()=>{
 const facts={accounts:[account(1),account(2)],costAccounts:[{account_id:1,records:3,valid_records:2,normalized_cost:10,first_at:'2026-10-07T02:00:00.000Z'},{account_id:2,records:1,valid_records:1,normalized_cost:50,first_at:'2026-10-07T02:00:00.000Z'}]};
 const result=costGovernance(facts,[cache(1,10)],config,at,{defaultCnyPerApiUsd:2,walletCnyPerApiUsd:{}},'2026-01-01T00:00:00.000Z');
 expect(result).toMatchObject({records:4,knownRecords:2,knownCostCny:10,totalCostCny:null,complete:false,coveragePercent:50});
 expect(result.accounts[1]?.reason).toBe('provider_rate_missing');
 const historical=costGovernance(facts,[cache(1,10)],config,'2025-12-31',{defaultCnyPerApiUsd:1,walletCnyPerApiUsd:{}},'2026-01-01');
 expect(historical.knownRecords).toBe(0);
 expect(historical.accounts[0]?.reason).toBe('historical_provider_rate_missing');
});
test('instrumentation excludes worker, login and itself and never stores dynamic paths',()=>{
 for(const path of ['/health','/api/login','/api/internal/execute-worker-operation','/api/observability/report','/api/admin/read-status']) expect(observationPath(path)).toBeNull();
 expect(observationPath('/api/upstreams/secret-looking-id/delete')).toBe('/api/upstreams/:operation');
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
