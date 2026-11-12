import { expect,test } from 'bun:test';
import type { AppConfig } from './config';
import { dailyCostSql } from './observability-costs';
import { probeCostReport,probeCostSql } from './observability-probe-costs';
import { parseObservabilityConfig } from './observability-config';

const settings={sub2apiSuccessPercent:95,sub2apiTtftP95Ms:30000,api2businessNon5xxPercent:99.9,api2businessLatencyP95Ms:3000,walletFreshnessSeconds:3600,retentionDays:30,probeCostDailyBudgetCny:null,probeCostTrendFactor:1.5};
const config={observability:settings,sub2api:{newApiCredentials:[{baseUrl:'https://alias.example',walletKey:'https://wallet.example'}]}} as AppConfig;
const days=Array.from({length:14},(_,index)=>{
  const date=new Date(Date.UTC(2026,10,1+index));
  return {day:date.toISOString().slice(0,10),start_at:new Date(date.getTime()-8*3600000).toISOString(),
    end_at:new Date(date.getTime()+16*3600000).toISOString()};
});
const accounts=[{id:1,name:'probe-a',platform:'openai',type:'apikey',base_url:'https://alias.example',active:true},
  {id:2,name:'probe-b',platform:'anthropic',type:'apikey',base_url:'https://other.example',active:true}];
const groups=[{id:2,name:'api2business-probe-openai'},{id:3,name:'api2business-probe-anthropic'}];
const cost=(day:string,account:number,group:number,model:string,extra:Record<string,unknown>={})=>({
  day,account_id:account,group_id:group,model,records:1,input_tokens:10,output_tokens:5,
  historical_records:1,historical_cost_cny:1,rate_fallback_records:0,fallback_cost_usd:0,
  billing_fields_missing_records:0,first_at:`${day}T01:00:00.000Z`,...extra,
});
const report=(facts:Record<string,unknown>,cache:Record<string,unknown>[]=[])=>probeCostReport({days,accounts,groups,...facts},cache,config,
  {days:7,asOf:'2026-11-14T04:00:00.000Z',timezone:'Asia/Shanghai'});

test('probe and user cost predicates are inverse and stay separate',()=>{
  expect(probeCostSql).toContain("LOWER(COALESCE(k.name,'')) LIKE 'api2business-probe-%'");
  expect(probeCostSql).toContain("LOWER(COALESCE(g.name,'')) LIKE 'api2business-probe-%'");
  expect(probeCostSql).toContain("AND (p.id IS NOT NULL OR LOWER(COALESCE(g.name,'')) LIKE 'api2business-probe-%')");
  expect(dailyCostSql).toContain("AND p.id IS NULL AND LOWER(COALESCE(g.name,'')) NOT LIKE 'api2business-probe-%'");
});

test('probe costs resolve rates through bounded intervals instead of per-row rescans',()=>{
  expect(probeCostSql).toContain("rate_intervals AS MATERIALIZED");
  expect(probeCostSql).toContain("LEAD(at) OVER (PARTITION BY account_id ORDER BY at,rate_cny)");
  expect(probeCostSql).toContain("AND (rate.next_at IS NULL OR u.created_at<rate.next_at)");
  expect(probeCostSql).not.toContain("LEFT JOIN LATERAL");
});

test('daily buckets use configured timezone boundaries, tokens and partial-day flag',()=>{
  const data=report({probeCosts:[cost('2026-11-14',1,2,'gpt-probe',{records:2,input_tokens:100,output_tokens:20,historical_records:2,historical_cost_cny:8})]});
  expect(data.days).toHaveLength(7);
  expect(data.days.at(-1)).toMatchObject({day:'2026-11-14',dayStartAt:'2026-11-13T16:00:00.000Z',
    dayEndAt:'2026-11-14T16:00:00.000Z',dayComplete:false,requests:2,inputTokens:100,outputTokens:20,
    costCny:8,activeAccountCount:1,coveragePercent:100});
  expect(data.asOf).toBe('2026-11-14T04:00:00.000Z');
  expect(data.timezone).toBe('Asia/Shanghai');
});

test('missing multiplier or provider rate remains unknown with explicit coverage',()=>{
  const facts={probeCosts:[
    cost('2026-11-14',1,2,'gpt-probe',{records:2,historical_records:1,historical_cost_cny:3,rate_fallback_records:1,fallback_cost_usd:2}),
    cost('2026-11-14',2,3,'claude-probe',{rate_fallback_records:1,fallback_cost_usd:2,historical_records:0,historical_cost_cny:0}),
    cost('2026-11-14',2,3,'claude-probe-missing-fields',{historical_records:0,historical_cost_cny:0,billing_fields_missing_records:1}),
  ]};
  const cache=[{account_id:1,queried_at:'2026-11-14T00:00:00Z',last_success_result:{ok:true,billingMultiplier:{value:2,observedAt:'2026-11-13T00:00:00Z'}}}];
  const data=report(facts,cache);
  expect(data.coverage).toMatchObject({knownRecords:2,missingRecords:2,coveragePercent:50,complete:false});
  expect(data.coverage.missingReasons).toEqual({provider_rate_missing:1,billing_fields_missing:1});
  expect(data.summary.costCny).toBeNull();
  expect(data.summary.knownCostCny).toBe(7);
  expect(data.budget.status).toBe('insufficient_data');
});

test('historical cache evidence after first request cannot backfill cost',()=>{
  const data=report({probeCosts:[cost('2026-11-14',1,2,'gpt-probe',{rate_fallback_records:1,fallback_cost_usd:2,historical_records:0,historical_cost_cny:0})]},
    [{account_id:1,last_success_result:{ok:true,billingMultiplier:{value:2,observedAt:'2026-11-14T02:00:00Z'}}}]);
  expect(data.coverage).toMatchObject({knownRecords:0,missingRecords:1,complete:false});
  expect(data.coverage.missingReasons).toEqual({historical_provider_rate_missing:1});
  expect(data.days.at(-1)?.costCny).toBeNull();
});

test('window distribution includes account, group, platform, model and upstream shares',()=>{
  const data=report({probeCosts:[
    cost('2026-11-14',1,2,'gpt-probe',{records:2,historical_records:2,historical_cost_cny:8}),
    cost('2026-11-14',2,3,'claude-probe',{records:1,historical_records:1,historical_cost_cny:2}),
  ]});
  expect(data.distribution.byAccount[0]).toMatchObject({label:'probe-a',knownCostCny:8,costSharePercent:80});
  expect(data.distribution.byGroup[0]).toMatchObject({label:'api2business-probe-openai',knownCostCny:8});
  expect(data.distribution.byPlatform.map(item=>item.label)).toEqual(['openai','anthropic']);
  expect(data.distribution.byModel.map(item=>item.label)).toEqual(['gpt-probe','claude-probe']);
  expect(data.distribution.byUpstream.map(item=>item.label)).toEqual(['https://wallet.example','https://other.example']);
  expect(data.summary.activeAccountCount).toBe(2);
});

test('trend threshold from owning YAML produces more than three actionable savings suggestions',()=>{
  const baselineDays=days.slice(-14,-7).map((day,index)=>cost(day.day,1,2,'gpt-probe',{records:1,historical_records:1,
    historical_cost_cny:1,first_at:`${day.day}T01:00:0${index}.000Z`}));
  const data=report({probeCosts:[...baselineDays,cost('2026-11-14',1,2,'gpt-probe',{records:4,historical_records:4,historical_cost_cny:8})]});
  expect(data.summary.baseline7dMedianCny).toBe(1);
  expect(data.budget).toMatchObject({trendFactor:1.5,trendThresholdCny:1.5,trendExceeded:true,status:'exceeded',dailyBudgetCny:null});
  expect(data.budget.recommendations.length).toBeGreaterThanOrEqual(3);
  expect(data.budget.recommendations.every(item=>item.expectedSavingPercent>=0)).toBe(true);
  expect(data.budget.policy).toContain('未配置每日预算');
});

test('partial days and missing rate evidence still produce a bounded verdict',()=>{
  const baselineDays=days.slice(-14,-7).map(day=>cost(day.day,1,2,'gpt-probe',{records:1,historical_records:1,
    historical_cost_cny:1,first_at:`${day.day}T01:00:00.000Z`}));
  const budgeted={...config,observability:{...settings,probeCostDailyBudgetCny:5}} as AppConfig;
  const data=probeCostReport({days,accounts,groups,probeCosts:[...baselineDays,
    cost('2026-11-13',1,2,'gpt-probe',{records:6,historical_records:3,historical_cost_cny:7,rate_fallback_records:3,
      fallback_cost_usd:0,first_at:'2026-11-13T01:00:00.000Z'}),
    cost('2026-11-14',1,2,'gpt-probe',{records:1,historical_records:1,historical_cost_cny:0.2}),
  ]},[],budgeted,{days:7,asOf:'2026-11-14T04:00:00.000Z',timezone:'Asia/Shanghai'});
  expect(data.days.at(-1)).toMatchObject({day:'2026-11-14',dayComplete:false});
  expect(data.budget).toMatchObject({evaluationDay:'2026-11-13',evaluationCostCny:null,
    evaluationKnownCostCny:7,evaluationEstimatedCostCny:14,evaluationBasis:'estimated',overBudget:true,status:'exceeded'});
  expect(data.budget.recommendations.length).toBeGreaterThanOrEqual(3);
});

test('configured budget is evaluated without inventing a threshold',()=>{
  const budgeted={...config,observability:{...settings,probeCostDailyBudgetCny:5}} as AppConfig;
  const data=probeCostReport({days,accounts,groups,probeCosts:[
    cost('2026-11-14',1,2,'gpt-probe',{records:1,historical_records:1,historical_cost_cny:6}),
  ]},[],budgeted,{days:7,asOf:'2026-11-14T04:00:00.000Z',timezone:'Asia/Shanghai'});
  expect(data.budget).toMatchObject({dailyBudgetCny:5,overBudget:true,status:'exceeded'});
  expect(data.budget.recommendations.length).toBeGreaterThanOrEqual(3);
});

test('probe cost settings require an explicit trend factor and nullable budget',()=>{
  expect(parseObservabilityConfig(settings)).toMatchObject({probeCostDailyBudgetCny:null,probeCostTrendFactor:1.5});
  expect(parseObservabilityConfig({...settings,probeCostDailyBudgetCny:12})).toMatchObject({probeCostDailyBudgetCny:12});
  expect(()=>parseObservabilityConfig({...settings,probeCostDailyBudgetCny:0})).toThrow();
  expect(()=>parseObservabilityConfig({...settings,probeCostTrendFactor:undefined})).toThrow();
});
