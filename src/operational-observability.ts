import type { AppConfig } from "./config";
import type { OperationsStore } from "./operations-store";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import { observabilitySql } from "./observability-sql";
import { configuredWalletKey, preferSharedWalletBalance, usageBalanceSourceAt } from "./upstream-wallet";
import { readUpstreamValuationPolicy } from "./upstream-valuation";
import { statSync } from "node:fs";
import { dailyCostSql, dailyWalletCosts } from "./observability-costs";
import { sourceCoverageFacts, sourceCoverageSql } from "./observability-source-coverage";

type Row = Record<string, any>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const finite = (value: unknown): number | null => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const iso = (value: unknown): string | null => value instanceof Date ? value.toISOString() : Number.isFinite(Date.parse(String(value))) ? new Date(String(value)).toISOString() : null;

export function observationWindow(start?: string | null, end?: string | null, now = Date.now()) {
  if (Boolean(start) !== Boolean(end)) throw new Error("start and end must be supplied together");
  if ([start,end].some(value => value && !/T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value))) throw new Error("invalid observation window: timezone is required");
  const until = end ? Date.parse(end) : now;
  const since = start ? Date.parse(start) : until - 7200000;
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until || until > now + 1000) throw new Error("invalid observation window");
  return { start: new Date(since).toISOString(), end: new Date(until).toISOString(), boundary: "[start,end)", seconds: (until - since) / 1000 };
}

export function observationPath(path: string): string | null {
  if (!path.startsWith("/api/") || /^\/api\/(?:internal|observability|login|logout)(?:\/|$)/u.test(path)
    || path === "/api/admin/read-status") return null;
  // Never persist free-form path segments, query strings, credentials or request bodies.
  if (/^\/api\/v2\/upstream-scheduling\/(?:scopes|snapshot|plan|probe-history|model-sync(?:\/plan|\/run)?)$/u.test(path)) return path;
  const parts = path.split("/");
  return parts.slice(0, 3).join("/") + (parts.length > 3 ? "/:operation" : "");
}

export function slo(value: number | null, target: number | undefined, direction: "min" | "max" | "above", complete = true) {
  const comparison = direction === "above" ? "gt" : direction === "min" ? "gte" : "lte";
  const sufficient = complete && value !== null && target !== undefined;
  const met = sufficient && (comparison === "gt" ? value > target : comparison === "gte" ? value >= target : value <= target);
  return { value, target: target ?? null, comparison, status: !sufficient ? "insufficient_data" : met ? "met" : "missed" };
}

export function walletGovernance(accounts: Row[], cache: Row[], config: AppConfig, capturedAt: string) {
  const byId = new Map(cache.map(item => [Number(item.account_id), item]));
  const wallets = new Map<string, Row>();
  const observations = new Map<string, Array<{ accountId: number; remainingUsd: number; sourceAt: string }>>();
  for (const account of accounts.filter(a => a.active && a.type === "apikey")) {
    const walletKey = configuredWalletKey(account.base_url, config.sub2api.newApiCredentials) || `unknown-account:${account.id}`;
    let wallet = wallets.get(walletKey);
    if (!wallet) {
      wallet = { walletKey, accountIds: [], platforms: [], remainingUsd: null, state: "unknown", sourceAccountId: null, sourceAt: null, lastAttemptAt: null, lastAttemptOk: null, conflictingBalances: false };
      wallets.set(walletKey, wallet);
    }
    wallet.accountIds.push(Number(account.id));
    if (!wallet.platforms.includes(account.platform)) wallet.platforms.push(account.platform);
    const item = byId.get(Number(account.id));
    if (!item) continue;
    const attemptedAt = iso(item.queried_at);
    if (attemptedAt && (!wallet.lastAttemptAt || attemptedAt > wallet.lastAttemptAt)) {
      wallet.lastAttemptAt = attemptedAt; wallet.lastAttemptOk = row(item.result).ok === true;
    }
    const evidence = row(item.last_success_result ?? item.result);
    const sourceAt = usageBalanceSourceAt(evidence, item.last_success_at ?? item.queried_at);
    const quota = row(evidence.quota);
    const value = evidence.ok === true && quota.unit === "USD" ? finite(quota.remaining) : null;
    if (value !== null && sourceAt) {
      const previous = wallet.sourceAt ? { remaining: wallet.remainingUsd, timestamp: Date.parse(wallet.sourceAt) } : undefined;
      const values = observations.get(walletKey) ?? [];
      const sourceAccountId = Number(row(evidence.walletBalance).sourceAccountId ?? account.id);
      if (!values.some(item => item.accountId === sourceAccountId && item.sourceAt === sourceAt && item.remainingUsd === value)) {
        values.push({ accountId: sourceAccountId, remainingUsd: value, sourceAt });
      }
      observations.set(walletKey, values);
      if (preferSharedWalletBalance(previous, { remaining: value, timestamp: Date.parse(sourceAt) })) {
        Object.assign(wallet, { remainingUsd: value, sourceAt, sourceAccountId: row(evidence.walletBalance).sourceAccountId ?? Number(account.id), state: value < 0 ? "debt" : value === 0 ? "zero" : "known" });
      }
    } else if (!wallet.sourceAt && evidence.ok === true && quota.unlimited === true && !String(evidence.warning ?? "").includes("只返回 API Key 配额")) {
      Object.assign(wallet, { state: "unlimited", sourceAt, sourceAccountId: Number(account.id) });
    }
  }
  const results = [...wallets.values()].map((wallet): Row => {
    const values = observations.get(wallet.walletKey) ?? [];
    const latestAt = values.reduce((latest, value) => value.sourceAt > latest ? value.sourceAt : latest, "");
    const latest = values.filter(value => value.sourceAt === latestAt);
    wallet.conflictingBalances = new Set(latest.map(value => value.remainingUsd)).size > 1;
    wallet.balanceObservations = latest;
    wallet.supersededBalanceObservationCount = values.length - latest.length;
    const ageSeconds = wallet.sourceAt ? Math.max(0, (Date.parse(capturedAt) - Date.parse(wallet.sourceAt)) / 1000) : null;
    const stale = ageSeconds !== null && config.observability ? ageSeconds > config.observability.walletFreshnessSeconds : null;
    return { ...wallet, ageSeconds, freshness: stale === null ? "unknown" : stale ? "stale" : "fresh" };
  }).sort((a,b) => a.walletKey.localeCompare(b.walletKey));
  return { observedAt: capturedAt, walletCount: results.length, accountCount: results.reduce((n,w) => n+w.accountIds.length,0),
    knownBalanceUsd: results.reduce((n,w) => n+(w.remainingUsd ?? 0),0),
    unknownWallets: results.filter(w => w.state === "unknown").length,
    staleWallets: results.filter(w => w.freshness === "stale").length,
    sharedWallets: results.filter(w => w.accountIds.length > 1).length, wallets: results };
}

export function costGovernance(facts: Row, cache: Row[], config: AppConfig, end: string, valuation: { defaultCnyPerApiUsd: number; walletCnyPerApiUsd: Record<string,number> }, valuationAt: string) {
  const accounts = new Map<number, Row>((facts.accounts ?? []).map((a: Row) => [Number(a.id),a]));
  const byId = new Map(cache.map(item => [Number(item.account_id), item]));
  let knownRecords=0, records=0, inScopeRecords=0, outOfScopeRecords=0, knownCostCny=0;
  const costs = (facts.costAccounts ?? []).map((cost: Row) => {
    const account = accounts.get(Number(cost.account_id)) ?? {};
    const accountType = String(account.type ?? "").toLowerCase();
    const inScope = accountType === "apikey";
    const cacheRow = byId.get(Number(cost.account_id));
    const evidence = row(cacheRow?.last_success_result ?? cacheRow?.result);
    const multiplier = row(evidence.billingMultiplier);
    const rate = finite(multiplier.value);
    const observedAt = iso(multiplier.observedAt);
    const walletKey = configuredWalletKey(account.base_url, config.sub2api.newApiCredentials);
    const currencyRate = valuation.walletCnyPerApiUsd[walletKey] ?? valuation.defaultCnyPerApiUsd;
    let reason: string | null = null;
    if (!inScope) reason="non_apikey_not_in_scope";
    else if (!walletKey) reason="wallet_identity_missing";
    else if (!rate || rate<=0 || !observedAt) reason="provider_rate_missing";
    else if (observedAt > end || observedAt > String(cost.first_at)) reason="historical_provider_rate_missing";
    else if (valuationAt > String(cost.first_at)) reason="historical_currency_policy_missing";
    const historical=Number(cost.historical_records ?? 0);
    const fallback=inScope && !reason ? Number(cost.valid_records) : 0;
    const valid=inScope ? historical+fallback : 0;
    const known=valid ? Number(cost.historical_cost_cny ?? 0)+(fallback ? Number(cost.normalized_cost)*rate!*currencyRate : 0) : null;
    if (inScope && valid===Number(cost.records)) reason=null;
    const rowRecords = Number(cost.records);
    records += rowRecords;
    if (inScope) { inScopeRecords += rowRecords; knownRecords += valid; knownCostCny += known ?? 0; }
    else outOfScopeRecords += rowRecords;
    return { accountId: Number(cost.account_id), accountType, inScope, accountingStatus: inScope ? (valid === rowRecords ? "reconciled" : "incomplete") : "not_applicable", day: cost.day ?? null, recent24Hours:cost.recent_24h === true, walletKey: walletKey || null, records: rowRecords, knownRecords: valid,
      missingRecords: inScope ? rowRecords-valid : 0, outOfScopeRecords: inScope ? 0 : rowRecords, knownCostCny: known, reason: inScope ? (reason ?? (valid < rowRecords ? "billing_fields_missing" : null)) : reason,
      historicalRecords: historical,firstHistoricalRateAt:cost.first_rate_at ?? null,lastHistoricalRateAt:cost.last_rate_at ?? null,
      providerRate: rate, providerRateObservedAt: observedAt, currencyRate, currencyPolicyObservedAt: valuationAt };
  });
  return { records, inScopeRecords, outOfScopeRecords, knownRecords, missingRecords: inScopeRecords-knownRecords,
    coveragePercent: inScopeRecords ? knownRecords/inScopeRecords*100 : null,
    knownCostCny, totalCostCny: inScopeRecords > 0 && inScopeRecords===knownRecords ? knownCostCny : null,
    complete: inScopeRecords > 0 && inScopeRecords===knownRecords, accounts: costs };
}

export function observerCoverage(instances: Row[], start: string, end: string) {
  const from=Date.parse(start), until=Date.parse(end);
  let cursor=from, coveredMs=0, failedWrites=0, unlocatedFailedWrites=0, lifetimeFailedWrites=0;
  for (const instance of instances) {
    const left=Math.max(from,Date.parse(iso(instance.started_at) ?? "")), right=Math.min(until,Date.parse(iso(instance.last_seen_at) ?? ""));
    if (right>Math.max(left,cursor)) coveredMs += right-Math.max(left,cursor);
    cursor=Math.max(cursor,right);
    const lifetime=Number(instance.failed_writes ?? 0);
    lifetimeFailedWrites+=lifetime;
    let times=instance.failed_write_times;
    if (typeof times==='string') {
      try { times=JSON.parse(times); } catch { times=null; }
    }
    if (Array.isArray(times)) {
      failedWrites+=times.filter((at:unknown)=>typeof at==='string'&&Date.parse(at)>=from&&Date.parse(at)<until).length;
    } else {
      // Legacy counters have no timestamps: retain uncertainty, never invent a clean window.
      unlocatedFailedWrites+=lifetime;
    }
  }
  return { coveredSeconds: coveredMs/1000, windowSeconds: (until-from)/1000, failedWrites,
    lifetimeFailedWrites,unlocatedFailedWrites,
    complete: coveredMs >= until-from && failedWrites===0 && unlocatedFailedWrites===0, instances };
}

export class OperationalObservability {
  readonly instanceId = crypto.randomUUID();
  readonly startedAt = new Date().toISOString();
  private failedWrites = 0;
  private failedWriteTimes: string[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private pending = new Set<Promise<void>>();
  private beat: Promise<void> | null = null;
  constructor(private config: AppConfig, private store: OperationsStore, private reads: Sub2ApiReadClient) {}
  async start() {
    if (!this.config.observability) return;
    await this.touch();
    this.heartbeat=setInterval(() => { void this.touch(); },30000);
    this.heartbeat.unref();
  }
  private async touch() {
    if (!this.config.observability) return;
    if (this.beat) return this.beat;
    const oldest=Date.now()-this.config.observability.retentionDays*86400000;
    this.failedWriteTimes=this.failedWriteTimes.filter(at=>Date.parse(at)>=oldest);
    this.beat=this.store.observeInstance(this.instanceId,this.startedAt,this.failedWrites,this.config.observability.retentionDays,[...this.failedWriteTimes])
      .catch(() => { this.failedWrites++; this.failedWriteTimes.push(new Date().toISOString()); console.error(JSON.stringify({ observedAt:new Date().toISOString(), component:"observability",error:"heartbeat_write_failed" })); })
      .finally(() => { this.beat=null; });
    return this.beat;
  }
  observe(request: Request, response: Response, durationMs: number) {
    const path=observationPath(new URL(request.url).pathname);
    if (!path || !this.config.observability) return;
    const completedAt=new Date().toISOString();
    const write=this.store.observeHttp(completedAt,this.instanceId,path,response.status,durationMs)
      .catch(() => { this.failedWrites++; this.failedWriteTimes.push(completedAt); console.error(JSON.stringify({ observedAt:completedAt, component:"observability",error:"http_observation_write_failed" })); })
      .finally(() => this.pending.delete(write));
    this.pending.add(write);
  }
  async close() { if (this.heartbeat) clearInterval(this.heartbeat); await Promise.all(this.pending); await this.touch(); }
  async get(id: string) {
    if (!/^[\da-f-]{36}$/u.test(id)) throw new Error("invalid report id");
    const stored=await this.store.getSnapshot(`observability:${id}`);
    return stored?.payload ?? null;
  }
  async costs(start?: string | null,end?: string | null) {
    if (Boolean(start)!==Boolean(end)) throw new Error("start and end must be supplied together");
    const until=end ?? new Date().toISOString();
    const since=start ?? (end ? null : new Date(Date.parse(until)-168*3_600_000).toISOString());
    const window=observationWindow(since,until);
    const rates=await this.store.observedCostRates(window.start,window.end);
    const query=await this.reads.query<Row>({key:`observability.costs:${window.start}:${window.end}`,
      kind:"observability.costs",sql:dailyCostSql,
      parameters:[window.start,window.end,JSON.stringify(rates.map((r:Row)=>({...r,at:iso(r.at)}))),this.config.monitor.timezone],
      priority:"manual",cacheMode:"bypass-cache"});
    const facts=row(query.rows[0]?.facts);
    const cache=await this.store.getUpstreamUsageCache([]);
    const capturedAt=new Date().toISOString();
    const valuation=readUpstreamValuationPolicy(this.config.operations.ledgerYamlPath);
    const cost=costGovernance(facts,cache,this.config,window.end,valuation,statSync(this.config.operations.ledgerYamlPath).mtime.toISOString());
    const balances=walletGovernance(facts.accounts ?? [],cache,this.config,capturedAt);
    const wallets=dailyWalletCosts(cost.accounts,facts.accounts ?? [],balances.wallets).map(wallet=>{
      const currencyRate=valuation.walletCnyPerApiUsd[wallet.walletKey] ?? valuation.defaultCnyPerApiUsd;
      return {...wallet,recent24Hours:{...wallet.recent24Hours,coveredSeconds:Math.min(window.seconds,86400)},remainingCny:wallet.remainingUsd===null?null:wallet.remainingUsd*currencyRate,
        currencyRate,currencySource:"owning valuation policy"};
    });
    const id=crypto.randomUUID();
    const payload={ok:true,id,capturedAt,window,timeZone:this.config.monitor.timezone,cost,wallets,
      sources:{queryStartedAt:query.queryStartedAt,queryCompletedAt:query.queryCompletedAt,
        queueDurationMs:query.queueDurationMs,queryDurationMs:query.queryDurationMs},
      warnings:cost.complete?[]:["历史成本覆盖不完整；已知成本可用于保守估算，不能视为完整成本或续航保证。"],
      valuesPrinted:false};
    await this.store.completeSnapshot(`observability:${id}`,"observability.costs.v1",payload,capturedAt);
    return payload;
  }
  async report(start?: string | null,end?: string | null) {
    if (!this.config.observability) throw new Error("observability is not configured in owning YAML");
    const window=observationWindow(start,end);
    await Promise.all(this.pending); await this.touch();
    const rates=await this.store.observedCostRates(window.start,window.end);
    const query=await this.reads.query<Row>({ key:`observability:${window.start}:${window.end}`,kind:"observability.window",sql:observabilitySql,
      parameters:[window.start,window.end,JSON.stringify(rates.map((r:Row)=>({...r,at:iso(r.at)})))],priority:"manual",cacheMode:"bypass-cache" });
    const facts=row(query.rows[0]?.facts);
    const [cache,http]=await Promise.all([this.store.getUpstreamUsageCache([]),this.store.httpObservationFacts(window.start,window.end)]);
    let sourceCoverage;
    try {
      const sourceQuery=await this.reads.query<Row>({key:`observability.source-coverage:${window.start}:${window.end}`,
        kind:"observability.window",sql:sourceCoverageSql,parameters:[window.start,window.end],priority:"manual",cacheMode:"bypass-cache"});
      sourceCoverage={...sourceCoverageFacts(sourceQuery.rows[0]?.coverage ?? null),status:"available",
        queryStartedAt:sourceQuery.queryStartedAt,queryCompletedAt:sourceQuery.queryCompletedAt,
        queueDurationMs:sourceQuery.queueDurationMs,queryDurationMs:sourceQuery.queryDurationMs};
    } catch {
      sourceCoverage={...sourceCoverageFacts(null),status:"unavailable",error:"source_coverage_query_failed"};
    }
    const capturedAt=new Date().toISOString();
    const coverage=observerCoverage(http.instances,window.start,window.end);
    const settings=this.config.observability;
    const total=Number(facts.succeeded)+Number(facts.failed);
    const id=crypto.randomUUID();
    const payload={ ok:true,id,capturedAt,window,settings,valuesPrinted:false,
      sources:{ sub2api:{ queryStartedAt:query.queryStartedAt,queryCompletedAt:query.queryCompletedAt,queueDurationMs:query.queueDurationMs,queryDurationMs:query.queryDurationMs },
        walletAsOf:capturedAt,costPolicy:"recorded evidence at or before first usage; no historical backfill" },
      broker:this.reads.status(),
      sub2api:{ ...facts,accounts:undefined,costAccounts:undefined,requests:total,
        sourceCoverage,
        successSlo:slo(total ? Number(facts.succeeded)/total*100 : null,settings.sub2apiSuccessPercent,"above",Number(facts.missingRequestIdRecords)===0 && sourceCoverage.complete),
        ttftSlo:slo(finite(facts.ttftP95Ms),settings.sub2apiTtftP95Ms,"max",Number(facts.ttftKnown)===Number(facts.streaming) && sourceCoverage.complete) },
      api2business:{ ...http,coverage,layer:"application; public edge reachability is measured separately",
        non5xxSlo:slo(http.requests ? (http.requests-http.failed)/http.requests*100 : null,settings.api2businessNon5xxPercent,"min",coverage.complete),
        latencySlo:slo(finite(http.latency_p95_ms),settings.api2businessLatencyP95Ms,"max",coverage.complete) },
      wallets:walletGovernance(facts.accounts ?? [],cache,this.config,capturedAt),
      cost:costGovernance(facts,cache,this.config,window.end,readUpstreamValuationPolicy(this.config.operations.ledgerYamlPath),statSync(this.config.operations.ledgerYamlPath).mtime.toISOString()),
    };
    await this.store.completeSnapshot(`observability:${id}`,"observability.v1",payload,capturedAt);
    return payload;
  }
}
