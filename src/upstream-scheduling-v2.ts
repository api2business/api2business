import type { AppConfig, UpstreamSchedulingV2Scope } from "./config";
import type { ApplicationDispatcher } from "./dispatcher";
import { buildAccountPriorityPlan } from "./account-priority-plan";
import type { OperationsService } from "./operations-service";
import {
  readUpstreamValuationPolicy,
  upstreamBalanceRateByWallet,
} from "./upstream-valuation";
import { configuredWalletKey, usageWalletKey } from "./upstream-wallet";

type Row = Record<string, unknown>;

interface V2SnapshotData {
  refreshedAt: string | null;
  recentCallLimit: number;
  status: string;
  accounts: Row[];
  quotaCoverage: Row;
  poolQuality: Row;
  errors: Row;
  priorityHistory: Row[];
  automation: Row;
  quota: Row;
  usage: Row[];
  probeHistory: Row;
  modelSyncHistory: Row;
}

interface V2Reconciliation {
  status: string;
  mode: string;
  scope: string;
  checkedAt: string;
  checks: Array<Record<string, unknown> & { name: string; status: string }>;
  mismatchCount: number;
}

interface V2SnapshotPayload {
  ok: true;
  version: "v2";
  phase: string;
  scope: string;
  platform: string;
  eligibleGroupIds: number[];
  features: UpstreamSchedulingV2Scope["features"];
  readOnly: boolean;
  data: V2SnapshotData;
  reconciliation: V2Reconciliation;
  valuesPrinted: false;
}

const readModelSchemaVersion = "upstream-scheduling-v2-read-model-v1";

function records(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function normalizedIds(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b)
    : [];
}

function rowKey(row: Row): string {
  return JSON.stringify([
    String(row.accountId ?? ""),
    String(row.platform ?? ""),
    row.score ?? null,
    row.priority ?? null,
    String(row.currentStatus ?? row.status ?? ""),
  ]);
}

function cachedUsageResult(row: Row): Row {
  return object(row.last_success_result ?? row.result);
}

function enrichAccountCostEvidence(
  accounts: Row[],
  usageRows: unknown[],
  config: AppConfig,
): Row[] {
  const valuation = readUpstreamValuationPolicy(config.operations.ledgerYamlPath);
  const usageByAccount = new Map<number, Row>();
  for (const row of records(usageRows)) {
    const accountId = Number(row.account_id ?? row.accountId);
    if (Number.isSafeInteger(accountId) && accountId > 0) usageByAccount.set(accountId, cachedUsageResult(row));
  }
  return accounts.map((account) => {
    const usage = usageByAccount.get(Number(account.accountId));
    const multiplier = Number(object(usage?.billingMultiplier).value);
    const detected = Number.isFinite(multiplier) && multiplier > 0 && usage
      ? multiplier * upstreamBalanceRateByWallet(
        configuredWalletKey(usage.walletKey ?? usage.baseUrl ?? account.accountName, config.sub2api.newApiCredentials),
        valuation.defaultCnyPerApiUsd,
        valuation.walletCnyPerApiUsd,
      )
      : null;
    const configured = typeof object(account.usage).costRateCnyPerApiUsd === "number"
      && Number.isFinite(Number(object(account.usage).costRateCnyPerApiUsd))
      && Number(object(account.usage).costRateCnyPerApiUsd) > 0
      ? Number(object(account.usage).costRateCnyPerApiUsd)
      : null;
    const effective = detected ?? configured;
    const billingMultiplier = object(usage?.billingMultiplier);
    return {
      ...account,
      configuredCostRateCnyPerApiUsd: configured,
      detectedCostRateCnyPerApiUsd: detected,
      effectiveCostRateCnyPerApiUsd: effective,
      costSource: detected !== null ? "detected" : configured !== null ? "manual" : null,
      costProbe: detected === null ? null : {
        source: billingMultiplier.source == null ? "unknown" : String(billingMultiplier.source),
        scope: billingMultiplier.scope == null ? null : String(billingMultiplier.scope),
        observedAt: billingMultiplier.observedAt == null ? null : String(billingMultiplier.observedAt),
        queriedAt: usage?.queriedAt == null ? null : String(usage.queriedAt),
      },
    };
  });
}

function enrichAccountsWithQuotaCache(accounts: Row[], usageRows: unknown[], config: AppConfig) {
  const refs = config.sub2api.newApiCredentials;
  const valuation = readUpstreamValuationPolicy(config.operations.ledgerYamlPath);
  const cachedByAccount = new Map<number, {
    result: Row;
    cachedAt: string | null;
    status: "cached" | "unlimited" | "unavailable";
  }>();
  const cachedByWallet = new Map<string, {
    result: Row;
    cachedAt: string | null;
    timestamp: number;
  }>();
  for (const row of records(usageRows)) {
    const accountId = Number(row.account_id ?? row.accountId);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
    const result = cachedUsageResult(row);
    const walletKey = usageWalletKey(result, refs);
    const quota = object(result.quota);
    const remaining = Number(quota.remaining);
    const hasQuota = result.ok === true
      && String(quota.unit ?? "").toUpperCase() === "USD"
      && quota.remaining !== null && quota.remaining !== undefined
      && Number.isFinite(remaining);
    const status: "cached" | "unlimited" | "unavailable" = hasQuota
      ? "cached"
      : result.ok === true && quota.unlimited === true
        ? "unlimited"
        : "unavailable";
    const cached = {
      result,
      status,
      cachedAt: row.last_success_at == null
        ? row.queried_at == null ? null : String(row.queried_at)
        : String(row.last_success_at),
      walletKey,
    };
    cachedByAccount.set(accountId, cached);
    if (status === "cached" && walletKey) {
      const timestamp = Date.parse(cached.cachedAt ?? String(result.queriedAt ?? "")) || 0;
      const previous = cachedByWallet.get(walletKey);
      if (!previous || timestamp >= previous.timestamp) cachedByWallet.set(walletKey, { result, cachedAt: cached.cachedAt, timestamp });
    }
  }
  const missingAccountIds: number[] = [];
  const unavailableAccountIds: number[] = [];
  let numericAccountCount = 0;
  let unlimitedAccountCount = 0;
  const enriched: Row[] = accounts.map((account) => {
    const accountId = Number(account.accountId);
    const cached = cachedByAccount.get(accountId);
    const walletKey = configuredWalletKey(cached?.result.walletKey ?? cached?.result.baseUrl ?? account.accountName, refs);
    const shared = walletKey ? cachedByWallet.get(walletKey) : undefined;
    const effective = shared
      ? { result: shared.result, status: "cached" as const, cachedAt: shared.cachedAt }
      : cached;
    if (!effective) {
      if (Number.isSafeInteger(accountId) && accountId > 0) missingAccountIds.push(accountId);
      return {
        ...account,
        quota: null,
        quotaCacheAt: null,
        quotaCacheStatus: "missing",
      };
    }
    const quota = object(effective.result.quota);
    const remaining = effective.status === "cached"
      && String(quota.unit ?? "").toUpperCase() === "USD"
      && quota.remaining !== null
      && quota.remaining !== undefined
      ? Number(quota.remaining)
      : null;
    const accountBalanceCny = remaining !== null && Number.isFinite(remaining) && remaining >= 0
      ? remaining * upstreamBalanceRateByWallet(
        configuredWalletKey(effective.result.walletKey ?? effective.result.baseUrl ?? account.accountName, refs),
        valuation.defaultCnyPerApiUsd,
        valuation.walletCnyPerApiUsd,
      )
      : null;
    if (effective.status === "cached") numericAccountCount += 1;
    if (effective.status === "unlimited") unlimitedAccountCount += 1;
    if (effective.status === "unavailable") unavailableAccountIds.push(accountId);
    return {
      ...account,
      accountBalanceCny,
      quota: {
        limit: quota.limit ?? null,
        used: quota.used ?? null,
        remaining,
        unlimited: quota.unlimited ?? null,
        unit: quota.unit == null ? null : String(quota.unit),
      },
      quotaCacheAt: effective.cachedAt,
      quotaCacheStatus: effective.status,
    };
  });
  return {
    accounts: enriched,
    quotaCoverage: {
      accountCount: enriched.length,
      cachedAccountCount: enriched.length - missingAccountIds.length,
      numericAccountCount,
      unlimitedAccountCount,
      unavailableAccountIds: unavailableAccountIds.sort((a, b) => a - b),
      missingAccountIds: missingAccountIds.sort((a, b) => a - b),
      complete: missingAccountIds.length === 0 && unavailableAccountIds.length === 0 && unlimitedAccountCount === 0,
      cacheRowsComplete: missingAccountIds.length === 0,
      source: "quota-monitor-usage-cache",
      valuesPrinted: false,
    },
  };
}

function projectCachedQuotaBalances(payload: V2SnapshotPayload, config: AppConfig): V2SnapshotPayload {
  const usageByAccount = new Map<number, Row>();
  for (const usage of records(payload.data.usage)) {
    const accountId = Number(usage.accountId ?? usage.account_id);
    if (Number.isSafeInteger(accountId) && accountId > 0) usageByAccount.set(accountId, usage);
  }
  const valuation = readUpstreamValuationPolicy(config.operations.ledgerYamlPath);
  const accounts = payload.data.accounts.map((account) => {
    const usage = usageByAccount.get(Number(account.accountId));
    const usageQuota = object(usage?.quota);
    const accountQuota = object(account.quota);
    const unit = String(usageQuota.unit ?? accountQuota.unit ?? "").toUpperCase();
    const rawRemaining = usageQuota.remaining ?? accountQuota.remaining;
    const remaining = unit === "USD" && rawRemaining !== null && rawRemaining !== undefined
      ? Number(rawRemaining)
      : null;
    const accountBalanceCny = remaining !== null && Number.isFinite(remaining) && remaining >= 0
      ? remaining * upstreamBalanceRateByWallet(
        configuredWalletKey(usage?.walletKey ?? usage?.baseUrl ?? account.accountName, config.sub2api.newApiCredentials),
        valuation.defaultCnyPerApiUsd,
        valuation.walletCnyPerApiUsd,
      )
      : null;
    return { ...account, accountBalanceCny };
  });
  return { ...payload, data: { ...payload.data, accounts } };
}

function accountBelongsToScope(row: Row, scope: UpstreamSchedulingV2Scope): boolean {
  if (String(row.platform ?? "").trim().toLowerCase() !== scope.platform) return false;
  const groupIds = normalizedIds(row.groupIds);
  return groupIds.some((groupId) => scope.eligibleGroupIds.includes(groupId));
}

function filteredHistory(recordsValue: unknown, scopeName: string): Row[] {
  return records(recordsValue).filter((row) => {
    const profiles = Array.isArray(row.profiles) ? row.profiles.map(String) : [String(row.profile ?? "")];
    return profiles.includes(scopeName);
  });
}

export class UpstreamSchedulingV2Error extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "UpstreamSchedulingV2Error";
  }
}

export class UpstreamSchedulingV2Service {
  private readonly memoryCache = new Map<string, {
    payload: V2SnapshotPayload;
    capturedAt: string;
  }>();
  private readonly inFlight = new Map<string, Promise<V2SnapshotPayload>>();

  constructor(
    private readonly config: AppConfig,
    private readonly dispatcher: ApplicationDispatcher,
    private readonly operations: OperationsService,
  ) {}

  private configuration() {
    const configuration = this.config.operations.upstreamSchedulingV2;
    if (!configuration?.enabled) {
      throw new UpstreamSchedulingV2Error(404, "v2_disabled", "上游调度 V2 未启用");
    }
    return configuration;
  }

  private scope(name: string | null | undefined): { name: string; scope: UpstreamSchedulingV2Scope } {
    const configuration = this.configuration();
    const scopeName = String(name ?? configuration.defaultScope).trim();
    const scope = configuration.scopes[scopeName];
    if (!scope || !scope.enabled) {
      throw new UpstreamSchedulingV2Error(404, "scope_unavailable", `上游调度 V2 作用域不可用：${scopeName}`);
    }
    return { name: scopeName, scope };
  }

  private cacheKey(scopeName: string): string {
    return `upstream-scheduling-v2:${scopeName}`;
  }

  private cacheMetadata(capturedAt: string, state: "hit" | "stale" | "refreshed", error: string | null = null) {
    const capturedAtMs = Date.parse(capturedAt);
    return {
      state,
      capturedAt,
      ageMs: Number.isFinite(capturedAtMs) ? Math.max(0, Date.now() - capturedAtMs) : null,
      ttlSeconds: this.config.operations.upstreamSchedulingV2?.readModelCacheSeconds ?? null,
      error,
      valuesPrinted: false,
    };
  }

  private withCache(payload: V2SnapshotPayload, capturedAt: string, state: "hit" | "stale" | "refreshed", error: string | null = null): V2SnapshotPayload & { cache: Row } {
    return { ...projectCachedQuotaBalances(payload, this.config), cache: this.cacheMetadata(capturedAt, state, error) };
  }

  private async persistedCache(scopeName: string): Promise<{ payload: V2SnapshotPayload; capturedAt: string } | null> {
    const key = this.cacheKey(scopeName);
    const memory = this.memoryCache.get(key);
    if (memory) return memory;
    const row = await this.operations.getReadModelSnapshot(key);
    const payload = object(row?.payload) as unknown as V2SnapshotPayload;
    if (row?.schema_version !== readModelSchemaVersion || Object.keys(payload).length === 0) return null;
    const capturedAt = row?.captured_at == null ? "" : String(row.captured_at);
    if (!capturedAt) return null;
    const cached = { payload, capturedAt };
    this.memoryCache.set(key, cached);
    return cached;
  }

  private async buildSnapshot(scopeName: string, scope: UpstreamSchedulingV2Scope): Promise<V2SnapshotPayload> {
    const source = await this.source(scopeName, scope);
    const payload: V2SnapshotPayload = {
      ok: true,
      version: "v2",
      phase: scopeName === "codex" ? "codex-reconciliation" : "scope-read",
      scope: scopeName,
      platform: scope.platform,
      eligibleGroupIds: scope.eligibleGroupIds,
      features: scope.features,
      readOnly: scope.features.planWrite !== true
        && scope.features.priorityAutomation !== true
        && scope.features.upstreamWrite !== true,
      data: {
        refreshedAt: source.scoreSnapshot.refreshedAt == null ? null : String(source.scoreSnapshot.refreshedAt),
        recentCallLimit: Number(source.scoreSnapshot.recentCallLimit ?? this.config.monitor.recentCallLimit),
        status: source.scoreSnapshot.status == null ? "unavailable" : String(source.scoreSnapshot.status),
        accounts: source.accounts,
        quotaCoverage: source.quotaCoverage,
        poolQuality: source.poolQuality,
        errors: source.errors,
        priorityHistory: source.priorityHistory,
        automation: source.automation,
        quota: source.quota,
        usage: source.usage,
        probeHistory: source.probeHistory,
        modelSyncHistory: source.modelSyncHistory,
      },
      reconciliation: this.reconciliation(scopeName, scope, source),
      valuesPrinted: false,
    };
    const capturedAt = new Date().toISOString();
    await this.operations.saveReadModelSnapshot(this.cacheKey(scopeName), readModelSchemaVersion, payload as unknown as Record<string, unknown>, capturedAt).catch((error) => {
      console.error(JSON.stringify({
        ok: false,
        component: "upstream-scheduling-v2-cache",
        action: "persist",
        scope: scopeName,
        error: error instanceof Error ? error.message : String(error),
        valuesPrinted: false,
      }));
    });
    this.memoryCache.set(this.cacheKey(scopeName), { payload, capturedAt });
    return payload;
  }

  private async refreshInBackground(scopeName: string, scope: UpstreamSchedulingV2Scope, cached: { payload: V2SnapshotPayload; capturedAt: string }): Promise<void> {
    if (this.inFlight.has(scopeName)) return;
    const refresh = this.buildSnapshot(scopeName, scope).catch((error) => {
      this.memoryCache.set(this.cacheKey(scopeName), cached);
      throw error;
    });
    this.inFlight.set(scopeName, refresh);
    try {
      await refresh;
    } catch (error) {
      console.error(JSON.stringify({
        ok: false,
        component: "upstream-scheduling-v2-cache",
        scope: scopeName,
        error: error instanceof Error ? error.message : String(error),
        valuesPrinted: false,
      }));
    } finally {
      if (this.inFlight.get(scopeName) === refresh) this.inFlight.delete(scopeName);
    }
  }

  listScopes() {
    const configuration = this.configuration();
    return {
      ok: true,
      version: "v2",
      defaultScope: configuration.defaultScope,
      scopes: Object.entries(configuration.scopes).map(([name, scope]) => ({
        name,
        enabled: scope.enabled,
        platform: scope.platform,
        eligibleGroupIds: scope.eligibleGroupIds,
        features: scope.features,
      })),
      valuesPrinted: false,
    };
  }

  async modelSyncPlan(scopeName?: string | null, accountIds: number[] = []) {
    const selected = this.scope(scopeName).name;
    return await this.operations.modelSyncPlan(selected, accountIds);
  }

  async modelSyncRun(scopeName?: string | null, accountIds: number[] = []) {
    const selected = this.scope(scopeName).name;
    return await this.operations.runModelSync(selected, "manual", accountIds);
  }

  async modelSyncHistory(scopeName?: string | null, page = 1) {
    const selected = this.scope(scopeName).name;
    return await this.operations.modelSyncHistory(page, 10, selected);
  }

  private async source(scopeName: string, scope: UpstreamSchedulingV2Scope): Promise<{
    scoreSnapshot: Row;
    accounts: Row[];
    quotaCoverage: Row;
    poolQuality: Row;
    errors: Row;
    priorityHistory: Row[];
    quota: Row;
    usage: Row[];
    probeHistory: Row;
    modelSyncHistory: Row;
    automation: Row;
    modelSync: Row;
  }> {
    if (!scope.features.scoreRead) {
      throw new UpstreamSchedulingV2Error(409, "feature_disabled", `${scopeName}.features.scoreRead=false`);
    }
    const scoreSnapshot = object(await this.dispatcher.dispatch({ kind: "scores.get" }));
    const sourceAccounts = records(scoreSnapshot.accounts);
    const accounts = sourceAccounts.filter((row) => accountBelongsToScope(row, scope));
    const qualityProfile = scope.platform === "openai"
      ? "codex"
      : scope.platform === "anthropic"
        ? "claude"
        : "grok";
    const accountIds = accounts.map((row) => Number(row.accountId));
    const [poolQualityRaw, errorsRaw, priorityHistoryRaw, quotaRaw, usageRows, probeHistoryRaw, modelSyncHistoryRaw] = await Promise.all([
      this.operations.poolQualitySummary(qualityProfile),
      this.operations.poolQualityErrors({ platform: qualityProfile, page: 1, pageSize: 20, filter: "all", priority: "automatic" }),
      this.operations.priorityHistory(),
      this.operations.upstreamQuotaSummary(accountIds),
      accountIds.length ? this.operations.getUpstreamUsageCache([]) : Promise.resolve([]),
      scope.features.idleProbe
        ? this.operations.idleProbeHistory(1, 10, scopeName)
        : Promise.resolve({ records: [], pagination: { page: 1, totalPages: 1, total: 0 } }),
      typeof this.operations.modelSyncHistory === "function"
        ? this.operations.modelSyncHistory(1, 10, scopeName)
        : Promise.resolve({ ok: true, scope: scopeName, automaticEnabled: false, batchSize: this.configuration().modelSync.batchSize, intervalSeconds: this.configuration().modelSync.intervalSeconds, records: [], pagination: { page: 1, totalPages: 1, total: 0 }, valuesPrinted: false }),
    ]);
    const poolQuality = object(poolQualityRaw);
    const errors = object(errorsRaw);
    const priorityHistory = object(priorityHistoryRaw);
    const quota = object(quotaRaw);
    const probeHistory = object(probeHistoryRaw);
    const modelSyncHistory = object(modelSyncHistoryRaw);
    const costAccounts = enrichAccountCostEvidence(accounts, usageRows, this.config);
    const quotaProjection = enrichAccountsWithQuotaCache(costAccounts, usageRows, this.config);
    return {
      scoreSnapshot,
      accounts: quotaProjection.accounts,
      quotaCoverage: quotaProjection.quotaCoverage,
      poolQuality,
      errors,
      priorityHistory: filteredHistory(priorityHistory.records, scopeName),
      automation: {
        enabled: scope.features.priorityAutomation,
        interval_seconds: this.configuration().automation.intervalSeconds,
        recent_call_limit: this.configuration().automation.recentCallLimit,
        owner: "upstream-scheduling-v2",
        scope: scopeName,
      },
      modelSync: {
        enabled: scope.features.modelSyncAutomation,
        batch_size: this.configuration().modelSync.batchSize,
        interval_seconds: this.configuration().modelSync.intervalSeconds,
        owner: "upstream-scheduling-v2",
        scope: scopeName,
      },
      quota,
      usage: records(usageRows).map(cachedUsageResult).filter((row) => Object.keys(row).length > 0),
      probeHistory,
      modelSyncHistory,
    };
  }

  private reconciliation(
    scopeName: string,
    scope: UpstreamSchedulingV2Scope,
    source: Awaited<ReturnType<UpstreamSchedulingV2Service["source"]>>,
  ): V2Reconciliation {
    const oldAccounts = records(source.scoreSnapshot.accounts).filter((row) => accountBelongsToScope(row, scope));
    const v2Accounts = source.accounts;
    const oldKeys = oldAccounts.map(rowKey).sort();
    const v2Keys = v2Accounts.map(rowKey).sort();
    const accountIds = [...new Set([
      ...oldAccounts.map((row) => String(row.accountId ?? "")),
      ...v2Accounts.map((row) => String(row.accountId ?? "")),
    ])].filter(Boolean).sort();
    const oldById = new Map(oldAccounts.map((row) => [String(row.accountId), row]));
    const v2ById = new Map(v2Accounts.map((row) => [String(row.accountId), row]));
    const fieldDiffs = accountIds.flatMap((accountId) => {
      const oldRow = oldById.get(accountId);
      const v2Row = v2ById.get(accountId);
      if (!oldRow || !v2Row) return [{ accountId, field: "presence", old: Boolean(oldRow), v2: Boolean(v2Row) }];
      return ["score", "priority", "currentStatus", "platform"].flatMap((field) =>
        String(oldRow[field] ?? "") === String(v2Row[field] ?? "")
          ? []
          : [{ accountId, field, old: oldRow[field] ?? null, v2: v2Row[field] ?? null }]
      );
    });
    const checks = [
      {
        name: "account-score",
        status: oldKeys.length === v2Keys.length && oldKeys.every((value, index) => value === v2Keys[index]) && fieldDiffs.length === 0 ? "matched" : "mismatch",
        oldCount: oldAccounts.length,
        v2Count: v2Accounts.length,
        differences: fieldDiffs,
      },
      {
        name: "pool-quality",
        status: source.poolQuality.platform === scopeName && normalizedIds(source.poolQuality.groupIds).join(",") === scope.eligibleGroupIds.join(",") ? "matched" : "mismatch",
        oldSource: "codex-reconciliation-read-model",
        v2Source: "v2-scope-projection",
        score: source.poolQuality.score ?? null,
        platform: source.poolQuality.platform ?? null,
        groupIds: source.poolQuality.groupIds ?? [],
      },
      {
        name: "priority-history",
        status: "matched",
        records: source.priorityHistory.length,
        scope: scopeName,
      },
      {
        name: "write-boundary",
        status: scope.features.planWrite === false && scope.features.upstreamWrite === false ? "matched" : "mismatch",
        planWrite: scope.features.planWrite,
        priorityAutomation: scope.features.priorityAutomation,
        upstreamWrite: scope.features.upstreamWrite,
      },
    ];
    const mismatches = checks.filter((check) => check.status !== "matched");
    return {
      status: mismatches.length === 0 ? "matched" : "mismatch",
      mode: "codex-read-model-to-v2-scope-projection",
      scope: scopeName,
      checkedAt: new Date().toISOString(),
      checks,
      mismatchCount: mismatches.length,
    };
  }

  async snapshot(scopeName?: string | null, forceRefresh = false): Promise<V2SnapshotPayload & { cache: Row }> {
    const selected = this.scope(scopeName);
    const cached = await this.persistedCache(selected.name);
    const ttlMs = (this.config.operations.upstreamSchedulingV2?.readModelCacheSeconds ?? 30) * 1000;
    const ageMs = cached ? Date.now() - Date.parse(cached.capturedAt) : Number.POSITIVE_INFINITY;
    const fresh = cached !== null && Number.isFinite(ageMs) && ageMs <= ttlMs;
    if (!forceRefresh && cached && fresh) return this.withCache(cached.payload, cached.capturedAt, "hit");
    if (forceRefresh && cached) {
      void this.refreshInBackground(selected.name, selected.scope, cached);
      return this.withCache(cached.payload, cached.capturedAt, "stale");
    }
    if (!forceRefresh && cached) {
      void this.refreshInBackground(selected.name, selected.scope, cached);
      return this.withCache(cached.payload, cached.capturedAt, "stale");
    }
    const existing = this.inFlight.get(selected.name);
    if (existing) {
      const payload = await existing;
      const current = this.memoryCache.get(this.cacheKey(selected.name));
      return this.withCache(payload, current?.capturedAt ?? new Date().toISOString(), "refreshed");
    }
    const refresh = this.buildSnapshot(selected.name, selected.scope);
    this.inFlight.set(selected.name, refresh);
    try {
      const payload = await refresh;
      const current = this.memoryCache.get(this.cacheKey(selected.name));
      return this.withCache(payload, current?.capturedAt ?? new Date().toISOString(), "refreshed");
    } catch (error) {
      if (cached) return this.withCache(cached.payload, cached.capturedAt, "stale", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (this.inFlight.get(selected.name) === refresh) this.inFlight.delete(selected.name);
    }
  }

  async probeHistory(scopeName?: string | null, page = 1) {
    const selected = this.scope(scopeName);
    if (selected.scope.features.idleProbe !== true) {
      return { ok: true, scope: selected.name, records: [], pagination: { page: 1, totalPages: 1, total: 0 } };
    }
    return { ...await this.operations.idleProbeHistory(page, 10, selected.name), scope: selected.name };
  }

  async plan(scopeName?: string | null) {
    const selected = this.scope(scopeName);
    if (!selected.scope.features.planRead) {
      throw new UpstreamSchedulingV2Error(409, "feature_disabled", `${selected.name}.features.planRead=false`);
    }
    const snapshot = await this.snapshot(selected.name);
    const ranking = {
      recentCallLimit: Number(snapshot.data.recentCallLimit ?? this.config.monitor.recentCallLimit),
      accounts: snapshot.data.accounts,
    };
    const rawPlan = object(buildAccountPriorityPlan(ranking, this.config));
    const changes = records(rawPlan.changes).filter((change) => String(change.profile ?? "") === selected.name);
    const priorities = Object.fromEntries(changes
      .filter((change) => change.change === "update")
      .map((change) => [String(change.accountId), Number(change.desiredPriority)]));
    const profiles = object(rawPlan.profiles);
    return {
      ok: true,
      version: "v2",
      scope: selected.name,
      platform: selected.scope.platform,
      generatedAt: new Date().toISOString(),
      recentCallLimit: ranking.recentCallLimit,
      changedCount: Object.keys(priorities).length,
      priorities,
      changes,
      profile: profiles[selected.name] ?? null,
      apply: {
        enabled: selected.scope.features.planWrite,
        mutation: false,
        reason: selected.scope.features.planWrite ? null : `${selected.name}.features.planWrite=false`,
      },
      reconciliation: snapshot.reconciliation,
      valuesPrinted: false,
    };
  }
}
