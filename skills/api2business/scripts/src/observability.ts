import { readFileSync,writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import type { AdminHttpClient } from '../../../../src/admin-http-client';
import { parseObservabilityConfig } from '../../../../src/observability-config';

type Row=Record<string,any>;
export const observabilityHelp={ok:true,commands:[
  'observability configure --file settings.json [--confirm] (YAML dry-run by default; restart API to apply)',
  'observability report [--start ISO --end ISO] --over-api [--include-records] (default: last 2 hours)',
  'observability get --id UUID --over-api [--include-records] (frozen report)',
  'observability check [--rounds 3] --over-api (read-only quota/recharge/broker sampling)',
], output:'Default report bounds wallet/cost details to 10 rows, with total and omitted counts. Full report remains available by id.'};
export function configureObservability(configPath:string,file:string,confirm:boolean) {
  const settings=parseObservabilityConfig(JSON.parse(readFileSync(file,'utf8')));
  if (!settings) throw new Error('settings must be a non-null object');
  const document=parseDocument(readFileSync(configPath,'utf8'));
  document.set('observability',settings);
  const root=document.toJS();
  const baseline=root.webProbe?.smokeProfiles?.[root.webProbe?.defaultSmokeProfile];
  if (baseline) document.setIn(['webProbe','smokeProfiles','observability'],{
    ...baseline,path:'/observability',readySelector:'#observability-state[data-ready="true"]',settleMs:2000,
    screenshotName:'api2business-observability-desktop.png',mobileScreenshotName:'api2business-observability-mobile.png',
  });
  if (confirm) writeFileSync(configPath,String(document));
  return {ok:true,applied:confirm,settings,restartRequired:confirm,valuesPrinted:false};
}
export function compactObservation(report:Row,full:boolean) {
  if (full) return report;
  const compact=(items:unknown) => { const rows=Array.isArray(items)?items:[];return {records:rows.slice(0,10),total:rows.length,omitted:Math.max(0,rows.length-10)}; };
  return {...report,wallets:report.wallets?{...report.wallets,wallets:compact(report.wallets.wallets)}:undefined,
    cost:report.cost?{...report.cost,accounts:compact(report.cost.accounts)}:undefined};
}
export async function checkObservability(client:AdminHttpClient,rounds:number) {
  if (!Number.isInteger(rounds)||rounds<1||rounds>10) throw new Error('--rounds must be 1..10');
  const samples:Row[]=[];
  for (let round=1;round<=rounds;round++) {
    for (const [endpoint,read] of [
      ['broker',()=>client.readStatus()],['quota',()=>client.upstreamQuotaSummary()],['recharge',()=>client.upstreamRechargeCandidates()],
    ] as const) {
      const observedAt=new Date().toISOString(),started=performance.now();
      try {
        const result=await read() as Row;
        samples.push({round,endpoint,observedAt,ok:result.ok===true,elapsedMs:Math.round(performance.now()-started),
          source:result.readExecutor ?? result.cache ?? {capturedAt:result.capturedAt ?? result.queryCompletedAt ?? null},
          error:result.ok===true?null:String(result.error??'unsuccessful_response')});
      } catch(error) {
        samples.push({round,endpoint,observedAt,ok:false,elapsedMs:Math.round(performance.now()-started),error:error instanceof Error?error.message:String(error)});
      }
    }
  }
  return {ok:samples.every(s=>s.ok),rounds,samples,valuesPrinted:false};
}
