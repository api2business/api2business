import type { AppConfig } from "./config";
import type { OperationsStore } from "./operations-store";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import { observabilitySql } from "./observability-sql";
import { configuredWalletKey, preferSharedWalletBalance } from "./upstream-wallet";
import { readUpstreamValuationPolicy } from "./upstream-valuation";
import { statSync } from "node:fs";

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
  const parts = path.split("/");
  return parts.slice(0, 3).join("/") + (parts.length > 3 ? "/:operation" : "");
}

export function slo(value: number | null, target: number | undefined, direction: "min" | "max", complete = true) {
  return { value, target: target ?? null, status: !complete || value === null || target === undefined ? "insufficient_data" : (direction === "min" ? value >= target : value <= target) ? "met" : "missed" };
}

export function walletGovernance(accounts: Row[], cache: Row[], config: AppConfig, capturedAt: string) {
  const byId = new Map(cache.map(item => [Number(item.account_id), item]));
  const wallets = new Map<string, Row>();
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
    const sourceAt = iso(item.last_success_at ?? item.queried_at);
    const quota = row(evidence.quota);
    const value = evidence.ok === true && quota.unit === "USD" ? finite(quota.remaining) : null;
    if (value !== null && sourceAt) {
      const previous = wallet.sourceAt ? { remaining: wallet.remainingUsd, timestamp: Date.parse(wallet.sourceAt) } : undefined;
      if (previous && previous.remaining !== value) wallet.conflictingBalances = true;
      if (preferSharedWalletBalance(previous, { remaining: value, timestamp: Date.parse(sourceAt) })) {
        Object.assign(wallet, { remainingUsd: value, sourceAt, sourceAccountId: Number(account.id), state: value < 0 ? "debt" : value === 0 ? "zero" : "known" });
      }
    } else if (!wallet.sourceAt && evidence.ok === true && quota.unlimited === true && !String(evidence.warning ?? "").includes("只返回 API Key 配额")) {
      Object.assign(wallet, { state: "unlimited", sourceAt, sourceAccountId: Number(account.id) });
    }
  }
  const results = [...wallets.values()].map((wallet): Row => {
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
  let knownRecords=0, records=0, knownCostCny=0;
  const costs = (facts.costAccounts ?? []).map((cost: Row) => {
    const account = accounts.get(Number(cost.account_id)) ?? {};
    const cacheRow = byId.get(Number(cost.account_id));
    const evidence = row(cacheRow?.last_success_result ?? cacheRow?.result);
    const multiplier = row(evidence.billingMultiplier);
    const rate = finite(multiplier.value);
    const observedAt = iso(multiplier.observedAt);
    const walletKey = configuredWalletKey(account.base_url, config.sub2api.newApiCredentials);
    const currencyRate = valuation.walletCnyPerApiUsd[walletKey] ?? valuation.defaultCnyPerApiUsd;
    let reason: string | null = null;
    if (account.type !== "apikey") reason="non_apikey_cost_not_reconciled";
    else if (!walletKey) reason="wallet_identity_missing";
    else if (!rate || rate<=0 || !observedAt) reason="provider_rate_missing";
    else if (observedAt > end || observedAt > String(cost.first_at)) reason="historical_provider_rate_missing";
    else if (valuationAt > String(cost.first_at)) reason="historical_currency_policy_missing";
    const historical=Number(cost.historical_records ?? 0);
    const fallback=reason ? 0 : Number(cost.valid_records);
    const valid=historical+fallback;
    const known=valid ? Number(cost.historical_cost_cny ?? 0)+(fallback ? Number(cost.normalized_cost)*rate!*currencyRate : 0) : null;
    if (valid===Number(cost.records)) reason=null;
    records += Number(cost.records); knownRecords += valid; knownCostCny += known ?? 0;
    return { accountId: Number(cost.account_id), walletKey: walletKey || null, records: Number(cost.records), knownRecords: valid,
      missingRecords: Number(cost.records)-valid, knownCostCny: known, reason: reason ?? (valid < Number(cost.records) ? "billing_fields_missing" : null),
      historicalRecords: historical,firstHistoricalRateAt:cost.first_rate_at ?? null,lastHistoricalRateAt:cost.last_rate_at ?? null,
      providerRate: rate, providerRateObservedAt: observedAt, currencyRate, currencyPolicyObservedAt: valuationAt };
  });
  return { records, knownRecords, missingRecords: records-knownRecords, coveragePercent: records ? knownRecords/records*100 : null,
    knownCostCny, totalCostCny: records > 0 && records===knownRecords ? knownCostCny : null,
    complete: records > 0 && records===knownRecords, accounts: costs };
}

export function observerCoverage(instances: Row[], start: string, end: string) {
  const from=Date.parse(start), until=Date.parse(end);
  let cursor=from, coveredMs=0, failedWrites=0;
  for (const instance of instances) {
    const left=Math.max(from,Date.parse(iso(instance.started_at) ?? "")), right=Math.min(until,Date.parse(iso(instance.last_seen_at) ?? ""));
    if (right>Math.max(left,cursor)) coveredMs += right-Math.max(left,cursor);
    cursor=Math.max(cursor,right); failedWrites+=Number(instance.failed_writes ?? 0);
  }
  return { coveredSeconds: coveredMs/1000, windowSeconds: (until-from)/1000, failedWrites,
    complete: coveredMs >= until-from && failedWrites===0, instances };
}

export class OperationalObservability {
  readonly instanceId = crypto.randomUUID();
  readonly startedAt = new Date().toISOString();
  private failedWrites = 0;
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
    this.beat=this.store.observeInstance(this.instanceId,this.startedAt,this.failedWrites,this.config.observability.retentionDays)
      .catch(() => { this.failedWrites++; console.error(JSON.stringify({ observedAt:new Date().toISOString(), component:"observability",error:"heartbeat_write_failed" })); })
      .finally(() => { this.beat=null; });
    return this.beat;
  }
  observe(request: Request, response: Response, durationMs: number) {
    const path=observationPath(new URL(request.url).pathname);
    if (!path || !this.config.observability) return;
    const completedAt=new Date().toISOString();
    const write=this.store.observeHttp(completedAt,this.instanceId,path,response.status,durationMs)
      .catch(() => { this.failedWrites++; console.error(JSON.stringify({ observedAt:completedAt, component:"observability",error:"http_observation_write_failed" })); })
      .finally(() => this.pending.delete(write));
    this.pending.add(write);
  }
  async close() { if (this.heartbeat) clearInterval(this.heartbeat); await Promise.all(this.pending); await this.touch(); }
  async get(id: string) {
    if (!/^[\da-f-]{36}$/u.test(id)) throw new Error("invalid report id");
    const stored=await this.store.getSnapshot(`observability:${id}`);
    return stored?.payload ?? null;
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
        successSlo:slo(total ? Number(facts.succeeded)/total*100 : null,settings.sub2apiSuccessPercent,"min",Number(facts.missingRequestIdRecords)===0),
        ttftSlo:slo(finite(facts.ttftP95Ms),settings.sub2apiTtftP95Ms,"max",Number(facts.ttftKnown)===Number(facts.streaming)) },
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
