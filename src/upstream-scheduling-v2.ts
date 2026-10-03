import type { AppConfig, UpstreamSchedulingV2Scope } from "./config";
import type { ApplicationDispatcher } from "./dispatcher";
import { buildAccountPriorityPlan } from "./account-priority-plan";
import type { OperationsService } from "./operations-service";

type Row = Record<string, unknown>;

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

function enrichAccountsWithQuotaCache(accounts: Row[], usageRows: unknown[]) {
  const cachedByAccount = new Map<number, {
    result: Row;
    cachedAt: string | null;
    status: "cached" | "unlimited" | "unavailable";
  }>();
  for (const row of records(usageRows)) {
    const accountId = Number(row.account_id ?? row.accountId);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
    const result = cachedUsageResult(row);
    const quota = object(result.quota);
    const remaining = Number(quota.remaining);
    const hasQuota = result.ok === true
      && String(quota.unit ?? "").toUpperCase() === "USD"
      && quota.remaining !== null && quota.remaining !== undefined
      && Number.isFinite(remaining);
    const status = hasQuota
      ? "cached"
      : result.ok === true && quota.unlimited === true
        ? "unlimited"
        : "unavailable";
    cachedByAccount.set(accountId, {
      result,
      status,
      cachedAt: row.last_success_at == null
        ? row.queried_at == null ? null : String(row.queried_at)
        : String(row.last_success_at),
    });
  }
  const missingAccountIds: number[] = [];
  const unavailableAccountIds: number[] = [];
  let numericAccountCount = 0;
  let unlimitedAccountCount = 0;
  const enriched: Row[] = accounts.map((account) => {
    const accountId = Number(account.accountId);
    const cached = cachedByAccount.get(accountId);
    if (!cached) {
      if (Number.isSafeInteger(accountId) && accountId > 0) missingAccountIds.push(accountId);
      return {
        ...account,
        quota: null,
        quotaCacheAt: null,
        quotaCacheStatus: "missing",
      };
    }
    const quota = object(cached.result.quota);
    if (cached.status === "cached") numericAccountCount += 1;
    if (cached.status === "unlimited") unlimitedAccountCount += 1;
    if (cached.status === "unavailable") unavailableAccountIds.push(accountId);
    return {
      ...account,
      quota: {
        limit: quota.limit ?? null,
        used: quota.used ?? null,
        remaining: cached.status === "cached" ? Number(quota.remaining) : null,
        unlimited: quota.unlimited ?? null,
        unit: quota.unit == null ? null : String(quota.unit),
      },
      quotaCacheAt: cached.cachedAt,
      quotaCacheStatus: cached.status,
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

  private async source(scopeName: string, scope: UpstreamSchedulingV2Scope) {
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
        : null;
    if (!qualityProfile) {
      throw new UpstreamSchedulingV2Error(409, "platform_unsupported", `V2 暂不支持平台：${scope.platform}`);
    }
    const accountIds = accounts.map((row) => Number(row.accountId));
    const [poolQuality, errors, priorityHistory, quota, usageRows, probeHistory] = await Promise.all([
      this.operations.poolQualitySummary(qualityProfile),
      this.operations.poolQualityErrors({ platform: qualityProfile, page: 1, pageSize: 20, filter: "all" }),
      this.operations.priorityHistory(),
      this.operations.upstreamQuotaSummary(accountIds),
      accountIds.length ? this.operations.getUpstreamUsageCache(accountIds) : Promise.resolve([]),
      qualityProfile === "codex" ? this.operations.idleProbeHistory(1, 10) : Promise.resolve({ records: [], pagination: { page: 1, totalPages: 1, total: 0 } }),
    ]);
    const quotaProjection = enrichAccountsWithQuotaCache(accounts, usageRows);
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
      quota,
      usage: records(usageRows).map(cachedUsageResult).filter((row) => Object.keys(row).length > 0),
      probeHistory,
    };
  }

  private reconciliation(
    scopeName: string,
    scope: UpstreamSchedulingV2Scope,
    source: Awaited<ReturnType<UpstreamSchedulingV2Service["source"]>>,
  ) {
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

  async snapshot(scopeName?: string | null) {
    const selected = this.scope(scopeName);
    const source = await this.source(selected.name, selected.scope);
    return {
      ok: true,
      version: "v2",
      phase: selected.name === "codex" ? "codex-reconciliation" : "scope-read",
      scope: selected.name,
      platform: selected.scope.platform,
      eligibleGroupIds: selected.scope.eligibleGroupIds,
      features: selected.scope.features,
      readOnly: selected.scope.features.planWrite !== true
        && selected.scope.features.priorityAutomation !== true
        && selected.scope.features.upstreamWrite !== true,
      data: {
        refreshedAt: source.scoreSnapshot.refreshedAt ?? null,
        recentCallLimit: source.scoreSnapshot.recentCallLimit ?? this.config.monitor.recentCallLimit,
        status: source.scoreSnapshot.status ?? "unavailable",
        accounts: source.accounts,
        quotaCoverage: source.quotaCoverage,
        poolQuality: source.poolQuality,
        errors: source.errors,
        priorityHistory: source.priorityHistory,
        automation: source.automation,
        quota: source.quota,
        usage: source.usage,
        probeHistory: source.probeHistory,
      },
      reconciliation: this.reconciliation(selected.name, selected.scope, source),
      valuesPrinted: false,
    };
  }

  async probeHistory(scopeName?: string | null, page = 1) {
    const selected = this.scope(scopeName);
    if (selected.scope.platform !== "openai") {
      return { ok: true, scope: selected.name, records: [], pagination: { page: 1, totalPages: 1, total: 0 } };
    }
    return { ...await this.operations.idleProbeHistory(page, 10), scope: selected.name };
  }

  async plan(scopeName?: string | null) {
    const selected = this.scope(scopeName);
    if (!selected.scope.features.planRead) {
      throw new UpstreamSchedulingV2Error(409, "feature_disabled", `${selected.name}.features.planRead=false`);
    }
    const source = await this.source(selected.name, selected.scope);
    const ranking = {
      recentCallLimit: Number(source.scoreSnapshot.recentCallLimit ?? this.config.monitor.recentCallLimit),
      accounts: source.accounts,
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
      reconciliation: this.reconciliation(selected.name, selected.scope, source),
      valuesPrinted: false,
    };
  }
}
