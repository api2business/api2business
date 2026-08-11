import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { AppConfig } from "./config";
import { collectRecentCallScoresFromDatabase } from "./account-score-database";
import { buildAccountPriorityPlan } from "./account-priority-plan";
import { collectErrorAggregateFromDatabase } from "./error-aggregate-database";
import { collectErrorDiagnosisFromDatabase } from "./error-diagnose-database";
import {
  collectErrorListFromDatabase,
  collectErrorRequestFromDatabase,
} from "./error-detail-database";
import {
  OperationsStore,
  type CashDirection,
  type PriorityOptimizationQueueLease,
} from "./operations-store";
import {
  buildPriorityWriteProfileQueues,
  exponentialRetryDelayMs,
  preparePriorityAutomationBatch,
  randomIntervalMs,
} from "./priority-automation-safety";
import { automationDispatchDelayMs } from "./priority-automation-dispatch";
import type {
  Sub2ApiReadClient,
  Sub2ApiReadPriority,
} from "./sub2api-read-executor";
import type { Sub2ApiRuntimeService } from "./sub2api-runtime-service";
import { collectUserImpactFromDatabase } from "./user-impact-database";
import {
  collectAccountBatchEconomics,
  type AccountBatchEconomicsInput,
} from "./account-batch-economics";
import {
  collectAlipayRevenue,
  type AlipayRevenueWindowInput,
} from "./alipay-revenue-database";
import { collectUserBalanceLiability } from "./user-balance-liability";
import { collectDailyProfitFacts } from "./daily-profit-facts";
import { buildDailyProfitReport } from "./daily-profit";
import { readAccountImportCosts } from "./account-import-cost-ledger";
import { readUpstreamRechargeCosts } from "./upstream-recharge-ledger";
import { runBoundedProcess } from "./bounded-process";
import {
  collectAccountImportEconomics,
  type AccountImportEconomicsInput,
} from "./account-import-economics";
import {
  collectOAuthPoolEconomics,
  mergeOAuthAcquisitionCosts,
  normalizeOAuthRefunds,
} from "./oauth-economics";
import {
  normalizeUpstreamWallet,
  readUpstreamValuationPolicy,
  upstreamBalanceRateByWallet,
} from "./upstream-valuation";
import { buildQuotaSamples, quotaHistory, summarizeQuotaSamples } from "./upstream-quota-monitor";
import {
  buildOAuthRuntimeSample,
  oauthRuntimeHistory,
  summarizeOAuthRuntimeSamples,
  type OAuthRuntimeProfile,
} from "./oauth-runtime-monitor";
import {
  collectPoolQualityErrors,
  collectPoolQualitySample,
  poolQualityHistory,
  type PoolQualityErrorFilter,
} from "./pool-quality-monitor";
import { IdleAccountProbeService } from "./idle-account-probe";
import type { ProbeIsolationService } from "./probe-isolation";
import { UpstreamBenchmarkService } from "./upstream-benchmark";
import { normalizeManualPriorityAssignments } from "./manual-priority-plan";
import { collectRechargeCandidates } from "./upstream-recharge-candidates";

export { normalizeUpstreamWallet, upstreamBalanceRateByWallet } from "./upstream-valuation";

const prioritiesByIdSql = `
SELECT id::text AS id, name AS account_name, priority::int AS priority,
  type AS account_type, platform
FROM accounts
WHERE id = ANY(string_to_array($1, ',')::bigint[])
`;

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row))
    : [];
}

export function latestSuccessfulUsageByWallet(rows: Array<Record<string, unknown>>): Map<string, Record<string, unknown>> {
  const selected = new Map<string, { result: Record<string, unknown>; queriedAt: number }>();
  for (const row of rows) {
    const result = object(row.last_success_result ?? row.result);
    const wallet = normalizeUpstreamWallet(result.baseUrl);
    const rawRemaining = object(result.quota).remaining;
    const remaining = rawRemaining === null || rawRemaining === undefined ? Number.NaN : Number(rawRemaining);
    const unit = String(object(result.quota).unit ?? "");
    if (!wallet || result.ok !== true || unit !== "USD" || !Number.isFinite(remaining)) continue;
    const queriedAt = Date.parse(String(row.last_success_at ?? row.queried_at ?? result.queriedAt ?? ""));
    const timestamp = Number.isFinite(queriedAt) ? queriedAt : 0;
    const previous = selected.get(wallet);
    if (!previous || timestamp >= previous.queriedAt) selected.set(wallet, { result, queriedAt: timestamp });
  }
  return new Map([...selected].map(([wallet, entry]) => [wallet, entry.result]));
}

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function applyPlanTypeRefunds(
  groups: Array<Record<string, unknown>>,
  refunds: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const refundsByPlanType = new Map<string, number>();
  for (const refund of refunds) {
    const planType = String(refund.planType ?? "").toLowerCase();
    refundsByPlanType.set(planType, (refundsByPlanType.get(planType) ?? 0) + money(refund.amountCny));
  }
  return groups.map((group) => {
    const grossCost = money(group.acquisitionCostCny);
    const refund = refundsByPlanType.get(String(group.planType ?? "").toLowerCase()) ?? 0;
    const netCost = Math.max(0, grossCost - refund);
    const apiAmountUsd = Number(group.apiAmountUsd);
    return {
      ...group,
      grossAcquisitionCostCny: grossCost,
      procurementRefundCny: refund,
      netAcquisitionCostCny: netCost,
      acquisitionCostCny: netCost,
      cnyPerApiUsd: apiAmountUsd > 0 ? netCost / apiAmountUsd : null,
    };
  });
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class OperationsService {
  private readonly idleProbe: IdleAccountProbeService;
  private readonly upstreamBenchmark: UpstreamBenchmarkService;

  constructor(
    private readonly config: AppConfig,
    private readonly store: OperationsStore,
    private readonly reads: Sub2ApiReadClient,
    private readonly runtime: Sub2ApiRuntimeService | null = null,
    private readonly probeIsolation: ProbeIsolationService | null = null,
  ) {
    this.idleProbe = new IdleAccountProbeService(config, reads, runtime, probeIsolation);
    this.upstreamBenchmark = new UpstreamBenchmarkService(config, store, probeIsolation);
  }

  async createUpstreamBenchmark(accountId: number, model: string) {
    const policy = this.config.operations.upstreamBenchmark;
    const selectedModel = model.trim() || policy.model;
    const runId = await this.store.startUpstreamBenchmark({ accountId, provider: policy.provider, benchmarkVersion: policy.benchmarkVersion, model: selectedModel });
    await this.store.addUpstreamBenchmarkEvent(runId, { stage: "submitted", message: "评测请求已创建，正在提交 Temporal" });
    return { runId, model: selectedModel };
  }

  async failUpstreamBenchmarkSubmission(runId: string, error: unknown) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/sk-[A-Za-z0-9_-]+/gu, "[REDACTED]").slice(0, 500);
    await this.store.finishUpstreamBenchmark(runId, { state: "failed", score: null, dimensions: {}, probes: [], durationMs: 0, errorSummary: message });
    await this.store.addUpstreamBenchmarkEvent(runId, { stage: "submission-failed", level: "error", message });
  }

  async runUpstreamBenchmark(runId: string, accountId: number, model: string) {
    return await this.upstreamBenchmark.run(runId, accountId, model);
  }

  async upstreamBenchmarks(accountIds: number[] = []) {
    const rows = await this.store.latestUpstreamBenchmarks(accountIds) as Array<Record<string, unknown>>;
    return { ok: true, results: rows.map((row) => ({
      id: row.id, accountId: Number(row.account_id), provider: row.provider,
      benchmarkVersion: row.benchmark_version, model: row.model, state: row.state,
      score: row.score === null ? null : Number(row.score), dimensions: row.dimensions,
      probes: row.probes, requestedAt: row.requested_at, completedAt: row.completed_at,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms), error: row.error_summary,
    })), valuesPrinted: false };
  }

  async upstreamBenchmarkDetail(runId: string) {
    const row = await this.store.upstreamBenchmarkRun(runId) as Record<string, unknown> | null;
    if (!row) return { ok: false, error: "benchmark run does not exist", runId, valuesPrinted: false };
    const events = await this.store.upstreamBenchmarkEvents(runId);
    return { ok: true, run: this.benchmarkRow(row), events: events.map((event: Record<string, unknown>) => ({
      sequence: Number(event.sequence), occurredAt: event.occurred_at, stage: event.stage,
      probeId: event.probe_id, level: event.level, message: event.message,
      durationMs: event.duration_ms === null ? null : Number(event.duration_ms), details: event.details,
    })), valuesPrinted: false };
  }

  async upstreamBenchmarkHistory(accountId: number, limit = 20) {
    const rows = await this.store.upstreamBenchmarkHistory(accountId, limit) as Array<Record<string, unknown>>;
    return { ok: true, accountId, records: rows.map((row) => this.benchmarkRow(row)), valuesPrinted: false };
  }

  private benchmarkRow(row: Record<string, unknown>) {
    return {
      id: row.id, accountId: Number(row.account_id), provider: row.provider,
      benchmarkVersion: row.benchmark_version, model: row.model, state: row.state,
      score: row.score === null ? null : Number(row.score), dimensions: row.dimensions,
      probes: row.probes, requestedAt: row.requested_at, completedAt: row.completed_at,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms), error: row.error_summary,
    };
  }

  async idleProbePlan(accountIds: number[] = []) {
    return await this.idleProbe.plan(accountIds, "manual");
  }

  async reconcileIdleProbe(accountIds: number[] = []) {
    return await this.idleProbe.reconcile(accountIds);
  }

  async idleProbeRollingUsage() {
    return await this.idleProbe.rollingUsage("manual");
  }

  async idleProbeHistory(page = 1, pageSize = 10) {
    if (!Number.isInteger(page) || page < 1) throw new Error("idle probe history page must be a positive integer");
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("idle probe history page size must be from 1 to 100");
    const rows = await this.store.idleProbeHistoryPage(pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    const total = Number(rows[0]?.total_count ?? 0);
    return {
      ok: true,
      records: rows.map((row) => ({
        operationId: row.operation_id,
        triggerType: row.trigger_type,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        status: row.status,
        planned: Number(row.planned_count),
        ready: Number(row.ready_count),
        attempted: Number(row.attempted_count),
        succeeded: Number(row.succeeded_count),
        failed: Number(row.failed_count),
        unready: Number(row.unready_count),
        durationMs: Number(row.duration_ms),
        errorSummary: row.error_summary,
      })),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
      valuesPrinted: false,
    };
  }

  async runIdleProbe(accountIds: number[] = [], rounds = 1, context?: {
    operationId: string;
    triggerType: "manual" | "automatic";
  }) {
    const startedAt = new Date();
    try {
      const result = await this.idleProbe.run(accountIds, rounds) as Record<string, unknown>;
      if (context) {
        const failed = Number(result.failed ?? 0);
        const attempted = Number(result.attempted ?? 0);
        const skipped = result.skipped === true;
        await this.store.addIdleProbeRound({
          operationId: context.operationId,
          triggerType: context.triggerType,
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          status: skipped ? "skipped" : failed === 0 && result.ok === true ? "succeeded" : attempted > failed ? "partial" : "failed",
          plannedCount: Number(result.planned ?? 0),
          readyCount: Number(result.ready ?? 0),
          attemptedCount: attempted,
          succeededCount: Number(result.succeeded ?? 0),
          failedCount: failed,
          unreadyCount: Array.isArray(result.unreadyAccountIds) ? result.unreadyAccountIds.length : 0,
          durationMs: Number(result.durationMs ?? Date.now() - startedAt.getTime()),
          errorSummary: null,
        });
      }
      return result;
    } catch (error) {
      if (context) {
        await this.store.addIdleProbeRound({
          operationId: context.operationId,
          triggerType: context.triggerType,
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          status: "failed",
          plannedCount: 0,
          readyCount: 0,
          attemptedCount: 0,
          succeededCount: 0,
          failedCount: 0,
          unreadyCount: 0,
          durationMs: Date.now() - startedAt.getTime(),
          errorSummary: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        });
      }
      throw error;
    }
  }

  async initialize(): Promise<void> {
    await this.store.migrate();
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  async health(): Promise<void> {
    await this.store.health();
  }

  async recoverConnection(error: unknown): Promise<boolean> {
    return await this.store.recoverConnection(error);
  }

  async getApiCache(key: string) {
    return await this.store.getApiCache(key);
  }

  async setApiCache(key: string, status: number, headers: Record<string, string>, body: string): Promise<void> {
    await this.store.setApiCache(key, status, headers, body);
  }

  async getUpstreamUsageCache(accountIds: number[]) {
    return await this.store.getUpstreamUsageCache(accountIds);
  }

  async restoreUpstreamUsageSuccess(input: Record<string, unknown>) {
    const accountId = Number(input.accountId);
    const remainingUsd = Number(input.remainingUsd);
    const baseUrl = normalizeUpstreamWallet(input.baseUrl);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error("上游账号 ID 无效");
    if (!Number.isFinite(remainingUsd) || remainingUsd < 0) throw new Error("历史成功余额必须是非负 USD 数值");
    if (!baseUrl.startsWith("https://")) throw new Error("历史成功快照 base_url 无效");
    if (input.confirm !== true) throw new Error("历史成功快照回填必须显式确认");
    const result = {
      ok: true,
      accountId,
      baseUrl,
      provider: "operator-confirmed-history",
      quota: { unit: "USD", remaining: remainingUsd },
      queriedAt: new Date().toISOString(),
      restored: true,
      valuesPrinted: false,
    };
    await this.store.restoreUpstreamUsageSuccess(accountId, result);
    return { ok: true, mutation: true, accountId, baseUrl, remainingUsd, valuesPrinted: false };
  }

  async setUpstreamUsageCache(results: Array<Record<string, unknown>>, apiAmountUsdTotal: number | null = null, recordSample = false): Promise<void> {
    const policy = readUpstreamValuationPolicy(this.config.operations.ledgerYamlPath);
    const sampledAt = new Date().toISOString();
    const samples = recordSample ? buildQuotaSamples(
      results, sampledAt,
      (wallet) => upstreamBalanceRateByWallet(wallet, policy.defaultCnyPerApiUsd, policy.walletCnyPerApiUsd),
    ) : [];
    await this.store.setUpstreamUsageCache(results, samples, apiAmountUsdTotal);
  }

  async upstreamQuotaSummary() {
    const displayHours = 8;
    const calculationWindowHours = 1;
    const rows = await this.store.getUpstreamQuotaSamples(displayHours + calculationWindowHours) as Array<Record<string, unknown>>;
    const samples = rows.map((row) => ({
      sampledAt: new Date(String(row.sampled_at)).toISOString(), walletKey: String(row.wallet_key), accountId: Number(row.account_id),
      schedulable: row.schedulable === true, status: String(row.status), provider: String(row.provider),
      probeOk: row.probe_ok === true, remainingUsd: row.remaining_usd == null ? null : Number(row.remaining_usd),
      cnyPerUsd: Number(row.cny_per_usd), remainingCny: row.remaining_cny == null ? null : Number(row.remaining_cny),
      sourceQueriedAt: row.source_queried_at == null ? null : String(row.source_queried_at),
      apiAmountUsdTotal: row.api_amount_usd_total == null ? null : Number(row.api_amount_usd_total),
      walletApiAmountUsdTotal: row.wallet_api_amount_usd_total == null ? null : Number(row.wallet_api_amount_usd_total),
      accountCostInputs: Array.isArray(row.account_cost_inputs)
        ? row.account_cost_inputs.map((item) => {
          const input = object(item);
          return {
            accountId: Number(input.accountId),
            apiAmountUsdTotal: Number(input.apiAmountUsdTotal),
            costRateCnyPerApiUsd: Number(input.costRateCnyPerApiUsd),
            source: input.source === "detected" ? "detected" as const : "manual" as const,
          };
        }).filter((item) => Number.isSafeInteger(item.accountId) && item.accountId > 0
          && Number.isFinite(item.apiAmountUsdTotal) && Number.isFinite(item.costRateCnyPerApiUsd)
          && item.costRateCnyPerApiUsd > 0)
        : [],
    }));
    return {
      ok: true,
      windowHours: calculationWindowHours,
      displayHours,
      ...summarizeQuotaSamples(samples, calculationWindowHours),
      history: quotaHistory(samples, calculationWindowHours, displayHours),
      valuesPrinted: false,
    };
  }

  async upstreamRechargeCandidates() {
    return await collectRechargeCandidates(this.config, this.store, this.reads);
  }

  async sampleOAuthRuntime(): Promise<Record<string, unknown>> {
    const sampledAt = new Date().toISOString();
    const samples = [];
    for (const profile of ["codex", "grok"] as const) {
      const result = await this.oauthPoolEconomics(1, 10, 1, profile, "automatic");
      samples.push(buildOAuthRuntimeSample(result, profile, sampledAt));
    }
    await this.store.addOAuthRuntimeSamples(samples);
    return { ok: true, sampledAt, profiles: samples.map((sample) => sample.profile), valuesPrinted: false };
  }

  async samplePoolQuality(): Promise<Record<string, unknown>> {
    const sample = await collectPoolQualitySample(this.config, this.reads);
    const usageRows = records(await this.store.getUpstreamUsageCache([]));
    const usageById = new Map(usageRows.map((row) => [Number(row.account_id), object(row.last_success_result ?? row.result)]));
    const valuation = readUpstreamValuationPolicy(this.config.operations.ledgerYamlPath);
    sample.participation = sample.participation.map((item) => {
      const usage = usageById.get(item.accountId);
      const multiplier = Number(object(usage?.billingMultiplier).value);
      const walletRate = upstreamBalanceRateByWallet(
        normalizeUpstreamWallet(usage?.baseUrl ?? item.baseUrl),
        valuation.defaultCnyPerApiUsd,
        valuation.walletCnyPerApiUsd,
      );
      const detected = Number.isFinite(multiplier) && multiplier > 0 ? multiplier * walletRate : null;
      return detected === null ? item : {
        ...item,
        costRateCnyPerApiUsd: detected,
        costSource: "detected" as const,
      };
    });
    await this.store.addPoolQualitySample(sample);
    return { ok: true, ...sample, valuesPrinted: false };
  }

  async poolQualitySummary() {
    const rows = await this.store.getPoolQualitySamples(8) as Array<Record<string, unknown>>;
    const latest = rows.at(-1) ?? null;
    return {
      ok: true,
      recentCallLimit: 1000,
      groupIds: this.config.sub2api.priorityPlan.eligibleGroupIds,
      sampledAt: latest ? new Date(String(latest.sampled_at)).toISOString() : null,
      score: latest?.score == null ? null : Number(latest.score),
      rollingScore: poolQualityHistory(rows).at(-1)?.rollingScore ?? null,
      grade: latest?.grade ?? "insufficient",
      observedAttempts: Number(latest?.observed_attempts ?? 0),
      participationAttempts: Array.isArray(latest?.participation)
        ? (latest.participation as Array<{ attempts?: unknown }>).reduce((total, item) => total + Number(item.attempts ?? 0), 0)
        : 0,
      successRequests: Number(latest?.success_requests ?? 0),
      failureRequests: Number(latest?.failure_requests ?? 0),
      failureRate: latest?.failure_rate == null ? null : Number(latest.failure_rate),
      failoverRequests: Number(latest?.failover_requests ?? 0),
      failoverRecovered: Number(latest?.failover_recovered ?? 0),
      ttftP95Ms: latest?.ttft_p95_ms == null ? null : Number(latest.ttft_p95_ms),
      firstTokenSamples: Number(latest?.first_token_samples ?? 0),
      participation: Array.isArray(latest?.participation) ? latest.participation : [],
      history: poolQualityHistory(rows),
      valuesPrinted: false,
    };
  }

  async poolQualityErrors(input: {
    page: number;
    pageSize: number;
    filter: PoolQualityErrorFilter;
    sampledAt?: string | null;
  }) {
    const samples = await this.store.getPoolQualitySamples(8) as Array<Record<string, unknown>>;
    const latest = samples.at(-1);
    const sampledAt = input.sampledAt
      ?? (latest?.sampled_at ? new Date(String(latest.sampled_at)).toISOString() : new Date().toISOString());
    return await collectPoolQualityErrors(this.config, this.reads, {
      sampledAt,
      page: input.page,
      pageSize: input.pageSize,
      filter: input.filter,
    });
  }

  async oauthRuntimeSummary(profile: OAuthRuntimeProfile) {
    const displayHours = 8;
    const calculationWindowHours = 1;
    const rows = await this.store.getOAuthRuntimeSamples(profile, displayHours + calculationWindowHours) as Array<Record<string, unknown>>;
    const samples = rows.map((row) => ({
      sampledAt: new Date(String(row.sampled_at)).toISOString(),
      profile,
      apiAmountUsdTotal: Number(row.api_amount_usd_total),
      expectedApiAmountUsd: row.expected_api_amount_usd == null ? null : Number(row.expected_api_amount_usd),
      remainingExpectedApiAmountUsd: row.remaining_expected_api_amount_usd == null ? null : Number(row.remaining_expected_api_amount_usd),
      accountCount: Number(row.account_count),
      normalCount: Number(row.normal_count),
      rateLimitedCount: Number(row.rate_limited_count),
      errorCount: Number(row.error_count),
    }));
    return {
      ok: true,
      profile,
      windowHours: calculationWindowHours,
      displayHours,
      ...summarizeOAuthRuntimeSamples(samples, calculationWindowHours),
      history: oauthRuntimeHistory(samples, calculationWindowHours, displayHours),
      valuesPrinted: false,
    };
  }

  private yamlLedger() {
    const root = parse(readFileSync(this.config.operations.ledgerYamlPath, "utf8")) as Record<string, unknown>;
    const profit = root.profit as Record<string, unknown> | undefined;
    const revenues: Array<Record<string, unknown>> = records(profit?.periodRevenues).map((row) => ({ ...row, source: "yaml", readOnly: true }));
    const costs: Array<Record<string, unknown>> = records(profit?.periodCosts).map((row) => ({ ...row, source: "yaml", readOnly: true }));
    return { revenues, costs };
  }

  private async alipay(period: string): Promise<{ completedOrders: number; revenueCny: number }> {
    const result = await this.alipayRevenue({ period });
    return {
      completedOrders: Number(result.completedOrders ?? 0),
      revenueCny: money(result.revenueCny),
    };
  }

  async alipayRevenue(input: AlipayRevenueWindowInput) {
    return await collectAlipayRevenue(this.config, this.reads, input, "manual");
  }

  async userBalanceLiability() {
    return await collectUserBalanceLiability(this.reads, "manual");
  }

  async dailyProfitFacts(day: string) {
    return await collectDailyProfitFacts(this.config, this.reads, day, "manual");
  }

  async dailyProfit(day: string) {
    const facts = await this.dailyProfitFacts(day);
    const cash = await this.store.cashDaySummary(day) as Record<string, unknown>;
    const root = parse(readFileSync(this.config.operations.ledgerYamlPath, "utf8")) as Record<string, unknown>;
    const profit = (root.profit ?? {}) as Record<string, unknown>;
    const revenues = records(profit.periodRevenues);
    const costs = records(profit.periodCosts);
    const importAccountIds = new Set(readAccountImportCosts(this.config.operations.accountImportLedgerPath)
      .filter((entry) => entry.occurredOn === day)
      .map((entry) => entry.accountId));
    const dayRevenues = revenues.filter((row) => row.occurredOn === day);
    const procurementRefundCny = dayRevenues
      .filter((row) => row.kind === "procurement-refund")
      .reduce((sum, row) => sum + Number(row.amountCny ?? 0), 0);
    const yamlIncomeCny = dayRevenues
      .filter((row) => row.kind !== "procurement-refund")
      .reduce((sum, row) => sum + Number(row.amountCny ?? 0), 0);
    const dayCosts = costs.filter((row) => row.occurredOn === day);
    const yamlUpstreamEntries = dayCosts
      .filter((row) => row.kind === "recharge")
      .map((row) => ({
        accountId: Number(row.accountId),
        accountName: String(row.accountName ?? ""),
        baseUrl: String(row.baseUrl ?? row.accountName ?? ""),
        amountCny: Number(row.amountCny ?? 0),
      }))
      .filter((entry) => Number.isSafeInteger(entry.accountId) && entry.accountId > 0
        && Number.isFinite(entry.amountCny) && entry.amountCny > 0);
    const duplicateAcquisitionIds = dayCosts
      .filter((row) => row.kind === "acquisition" && importAccountIds.has(Number(row.accountId)))
      .map((row) => Number(row.accountId));
    const yamlCostCny = dayCosts
      .filter((row) => row.kind !== "recharge"
        && !(row.kind === "acquisition" && importAccountIds.has(Number(row.accountId))))
      .reduce((sum, row) => sum + Number(row.amountCny ?? 0), 0);
    const upstreamEntries = [
      ...readUpstreamRechargeCosts(this.config.operations.upstreamRechargeLedgerPath)
        .filter((entry) => entry.occurredOn === day),
      ...yamlUpstreamEntries,
    ];
    const usageRows = await this.store.getUpstreamUsageCache([]) as Array<Record<string, unknown>>;
    const usageByWallet = latestSuccessfulUsageByWallet(usageRows);
    const rechargeByWallet = new Map<string, number>();
    const walletRemaining = new Map<string, number>();
    const missingWallets = new Set<string>();
    for (const entry of upstreamEntries) {
      const baseUrl = normalizeUpstreamWallet(entry.baseUrl ?? entry.accountName);
      const usage = usageByWallet.get(baseUrl);
      rechargeByWallet.set(baseUrl, (rechargeByWallet.get(baseUrl) ?? 0) + entry.amountCny);
      const rawRemaining = object(usage?.quota).remaining;
      const remaining = rawRemaining === null || rawRemaining === undefined ? Number.NaN : Number(rawRemaining);
      const unit = String(object(usage?.quota).unit ?? "");
      if (usage?.ok === true && unit === "USD" && Number.isFinite(remaining)) {
        walletRemaining.set(baseUrl, Math.max(walletRemaining.get(baseUrl) ?? 0, remaining));
      } else {
        missingWallets.add(baseUrl);
      }
    }
    const valuation = readUpstreamValuationPolicy(this.config.operations.ledgerYamlPath);
    const balanceRate = valuation.defaultCnyPerApiUsd;
    const balanceRateByWallet = valuation.walletCnyPerApiUsd;
    const upstreamCapitalCny = [...rechargeByWallet].reduce((sum, [wallet, recharge]) =>
      sum + Math.min(
        recharge,
        (walletRemaining.get(wallet) ?? 0) * upstreamBalanceRateByWallet(wallet, balanceRate, balanceRateByWallet),
      ), 0);
    const rate = Number(profit.deferredCostRateCnyPerApiUsd);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("profit.deferredCostRateCnyPerApiUsd must be a positive number");
    const period = day.slice(0, 7);
    const undatedEntries = [...revenues, ...costs]
      .filter((row) => row.period === period && typeof row.occurredOn !== "string").length;
    const warnings: string[] = [];
    if (undatedEntries > 0) warnings.push(`${undatedEntries} 条月度 YAML 账目没有 occurredOn，未纳入自然日核算`);
    if (duplicateAcquisitionIds.length > 0) warnings.push(`YAML 采购账号 #${duplicateAcquisitionIds.join(", #")} 已由导入账本计费，本次去重`);
    if (missingWallets.size > 0) {
      warnings.push(`上游余额资本缺少 ${missingWallets.size} 个充值钱包的可用 USD 快照，暂按 0 资本：${[...missingWallets].join(", ")}`);
    }
    return buildDailyProfitReport(facts, {
      manualIncomeCny: Number(cash.income_cny ?? 0),
      manualExpenseCny: Number(cash.expense_cny ?? 0),
      yamlIncomeCny,
      yamlCostCny,
      procurementRefundCny,
      upstreamRechargeCny: upstreamEntries.reduce((sum, entry) => sum + entry.amountCny, 0),
      upstreamCapitalCny,
      upstreamBalanceCnyPerApiUsd: balanceRate,
      upstreamCapitalCoverage: {
        rechargeWalletCount: rechargeByWallet.size,
        capitalizedWalletCount: walletRemaining.size,
        missingWallets: [...missingWallets],
      },
      deferredCostRateCnyPerApiUsd: rate,
      warnings,
    });
  }

  async ledger(period = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 7), page = 1, pageSize = 10) {
    const yaml = this.yamlLedger();
    const accountImports = readAccountImportCosts(this.config.operations.accountImportLedgerPath)
      .filter((entry) => entry.period === period)
      .map((entry) => ({ ...entry, readOnly: true }));
    const upstreamRecharges = readUpstreamRechargeCosts(this.config.operations.upstreamRechargeLedgerPath)
      .filter((entry) => entry.period === period)
      .map((entry) => ({
        source: "upstream-recharge",
        occurred_on: entry.occurredOn,
        direction: "expense",
        category: "upstream-recharge",
        amount_cny: entry.amountCny,
        description: entry.description,
        accountId: entry.accountId,
        readOnly: true,
      }));
    const alipay = await this.alipay(period);
    const staticRows = [
      { source: "alipay", period, direction: "income", kind: "alipay-completed", amountCny: alipay.revenueCny, description: `${alipay.completedOrders} 笔已完成订单（已排除管理员测试）`, readOnly: true },
      ...yaml.revenues.map((row) => ({ ...row, direction: "income" })),
      ...yaml.costs.map((row) => ({ ...row, direction: "expense" })),
      ...upstreamRecharges,
    ];
    const offset = (page - 1) * pageSize;
    const staticPage = staticRows.slice(offset, offset + pageSize);
    const manualLimit = pageSize - staticPage.length;
    const manualOffset = Math.max(0, offset - staticRows.length);
    const manualPage = manualLimit > 0 ? records(await this.store.listCashPage(manualLimit, manualOffset)) : [];
    const manualSummary = await this.store.cashSummary(period) as Record<string, unknown>;
    const manualTotal = Number(manualSummary.total_count ?? 0);
    const incomeCny = yaml.revenues.filter((row) => row.period === period).reduce((sum, row) => sum + money(row.amountCny), 0)
      + money(manualSummary.income_cny);
    const expenseCny = yaml.costs.filter((row) => row.period === period).reduce((sum, row) => sum + money(row.amountCny), 0)
      + money(manualSummary.expense_cny)
      + accountImports.reduce((sum, row) => sum + money(row.amountCny), 0)
      + upstreamRecharges.reduce((sum, row) => sum + money(row.amount_cny), 0);
    const totalIncomeCny = incomeCny + alipay.revenueCny;
    return {
      ok: true, period, accountImports: { count: accountImports.length }, alipay,
      records: [...staticPage, ...manualPage],
      pagination: { page, pageSize, total: staticRows.length + manualTotal, totalPages: Math.max(1, Math.ceil((staticRows.length + manualTotal) / pageSize)) },
      exclusions: ["管理员支付宝测试订单", "未完成支付宝订单", "API 流量估值"],
      summary: { incomeCny: totalIncomeCny, expenseCny, grossProfitCny: totalIncomeCny - expenseCny },
    };
  }

  async addCash(input: { occurredOn: string; direction: CashDirection; category: string; amountCny: number; description: string }, operator: string) {
    const row = await this.store.addCash({ ...input, operator });
    await this.store.audit("cash.create", "succeeded", operator,
      { occurredOn: input.occurredOn, direction: input.direction, category: input.category, amountCny: input.amountCny },
      { id: row.id });
    return { ok: true, entry: row };
  }

  async voidCash(id: string, reason: string, operator: string) {
    const row = await this.store.voidCash(id, operator, reason);
    await this.store.audit("cash.void", "succeeded", operator, { id, reason }, { id });
    return { ok: true, entry: row };
  }

  async generatePriorityPlan(
    recentCallLimit: number,
    operator: string,
    triggerType: "manual" | "automatic" = "manual",
    executionStartedAt: string | null = null,
  ): Promise<Record<string, unknown>> {
    return await this.store.withPriorityOptimizationQueue(async (queue) => {
      return await this.generatePriorityPlanQueued(
        recentCallLimit,
        operator,
        triggerType,
        executionStartedAt,
        queue,
      );
    });
  }

  async createManualPriorityPlan(
    requestedPriorities: Record<string, number>,
    operator: string,
  ): Promise<Record<string, unknown>> {
    const requested = normalizeManualPriorityAssignments(requestedPriorities);
    return await this.store.withPriorityOptimizationQueue(async (queue) => {
      const accountIds = Object.keys(requested);
      const read = await this.reads.query<Record<string, unknown>>({
        key: JSON.stringify(["priorities.manual-plan", accountIds]),
        kind: "priorities.manual-plan",
        sql: prioritiesByIdSql,
        parameters: [accountIds.join(",")],
        priority: "manual",
        cacheMode: "bypass-cache",
      });
      const rowsById = new Map(read.rows.map((row) => [String(row.id), row]));
      const missingIds = accountIds.filter((accountId) => !rowsById.has(accountId));
      if (missingIds.length > 0) throw new Error(`manual priority plan accounts do not exist: ${missingIds.join(",")}`);
      const oauthIds = accountIds.filter((accountId) =>
        String(rowsById.get(accountId)?.account_type ?? "").trim().toLowerCase() === "oauth"
      );
      if (oauthIds.length > 0) throw new Error(`manual priority plan rejected OAuth accounts: ${oauthIds.join(",")}`);

      const changes = accountIds.map((accountId) => {
        const row = rowsById.get(accountId)!;
        const beforePriority = Number(row.priority);
        const desiredPriority = requested[accountId]!;
        return {
          accountId: Number(accountId),
          accountName: String(row.account_name ?? accountId),
          profile: String(row.platform ?? "").trim().toLowerCase() === "grok" ? "grok" : "codex",
          beforePriority,
          desiredPriority,
          change: beforePriority === desiredPriority ? "unchanged" : "update",
        };
      });
      const priorities = Object.fromEntries(changes
        .filter((change) => change.change === "update")
        .map((change) => [String(change.accountId), change.desiredPriority]));
      const profileNames = [...new Set(changes.map((change) => change.profile))];
      const profiles = Object.fromEntries(profileNames.map((profile) => {
        const profileChanges = changes.filter((change) => change.profile === profile);
        return [profile, {
          requestedCount: profileChanges.length,
          changedCount: profileChanges.filter((change) => change.change === "update").length,
        }];
      }));
      const result = {
        ok: true,
        action: "priority-plan-manual-create",
        source: "operator-specified",
        mutation: false,
        recentCallLimit: 0,
        eligibleCount: changes.length,
        requestedCount: changes.length,
        changedCount: Object.keys(priorities).length,
        priorities,
        changes,
        profiles,
        databaseQueries: 1,
        queueDurationMs: read.queueDurationMs,
        queryDurationMs: read.queryDurationMs,
        totalDurationMs: read.totalDurationMs,
        apply: {
          through: "api2business-priority-plan-confirm",
          target: this.config.monitor.target,
          writeMode: "backend-api-paced",
          batchSize: this.config.operations.priorityWrite.batchSize,
          verification: "native-api-read-broker",
        },
      };
      const plan = await this.store.createPlan({
        operator,
        recentCallLimit: 0,
        ttlMinutes: this.config.operations.planTtlMinutes,
        priorities,
        result,
        triggerType: "manual",
      });
      await this.store.audit("priority.plan.generate", "succeeded", operator, {
        source: "operator-specified",
        accountIds: accountIds.map(Number),
      }, {
        planId: plan.id,
        changedCount: Object.keys(priorities).length,
        queueName: queue.queueName,
        queueWaitMs: queue.waitMs,
      });
      return { ...result, planId: plan.id, expiresAt: plan.expiresAt, queue };
    });
  }

  private async generatePriorityPlanQueued(
    recentCallLimit: number,
    operator: string,
    triggerType: "manual" | "automatic",
    executionStartedAt: string | null,
    queue: PriorityOptimizationQueueLease,
  ): Promise<Record<string, unknown>> {
    const candidate = await this.priorityState(
      recentCallLimit,
      triggerType === "automatic" ? "automatic" : "manual",
    );
    let result = candidate;
    let priorities = candidate.priorities as Record<string, number>;
    if (triggerType === "automatic") {
      const prepared = preparePriorityAutomationBatch(
        candidate,
        this.config.operations.automationSafety,
        this.config.operations.priorityWrite.batchSize,
      );
      priorities = prepared.selectedPriorities as Record<string, number>;
      const {
        selectedPriorities: _selectedPriorities,
        ...automationSafety
      } = prepared;
      result = {
        ...candidate,
        priorities,
        changedCount: Object.keys(priorities).length,
        candidateChangedCount: automationSafety.fullChangedCount,
        notSelectedChangedCount: automationSafety.notSelectedChangedCount,
        automationSafety,
      };
    }
    const plan = await this.store.createPlan({
      operator,
      recentCallLimit,
      ttlMinutes: this.config.operations.planTtlMinutes,
      priorities,
      result,
      triggerType,
      executionStartedAt,
    });
    await this.store.audit("priority.plan.generate", "succeeded", operator,
      { recentCallLimit, triggerType }, {
        planId: plan.id,
        changedCount: Object.keys(priorities).length,
        candidateChangedCount: result.candidateChangedCount ?? Object.keys(priorities).length,
        notSelectedChangedCount: result.notSelectedChangedCount ?? 0,
        automationMode: object(result.automationSafety).mode ?? null,
        queueName: queue.queueName,
        queueWaitMs: queue.waitMs,
      });
    return {
      ...result,
      planId: plan.id,
      expiresAt: plan.expiresAt,
      queue,
    };
  }

  async priorityState(
    recentCallLimit: number,
    priority: Sub2ApiReadPriority = "manual",
    accountSelector: string | null = null,
    groupSelector: string | null = null,
  ): Promise<Record<string, unknown>> {
    const ranking = await collectRecentCallScoresFromDatabase(
      this.config,
      recentCallLimit,
      this.reads,
      accountSelector,
      groupSelector,
      priority,
    );
    const usageRows = records(await this.store.getUpstreamUsageCache([]));
    const usageById = new Map(usageRows.map((row) => [Number(row.account_id), object(row.last_success_result ?? row.result)]));
    const valuation = readUpstreamValuationPolicy(this.config.operations.ledgerYamlPath);
    const accounts = records(ranking.accounts).map((row) => {
      const usage = usageById.get(Number(row.accountId));
      if (!usage || usage.ok !== true) return row;
      const quota = object(usage.quota);
      const remaining = quota.unit === "USD" ? Number(quota.remaining) : Number.NaN;
      const walletRate = upstreamBalanceRateByWallet(
        normalizeUpstreamWallet(usage.baseUrl ?? row.accountName),
        valuation.defaultCnyPerApiUsd,
        valuation.walletCnyPerApiUsd,
      );
      const multiplier = Number(object(usage.billingMultiplier).value);
      return {
        ...row,
        accountBalanceCny: Number.isFinite(remaining) ? Math.max(0, remaining) * walletRate : null,
        detectedCostRateCnyPerApiUsd: Number.isFinite(multiplier) && multiplier > 0 ? multiplier * walletRate : null,
      };
    });
    const poolQualityRows = await this.store.getPoolQualitySamples(8) as Array<Record<string, unknown>>;
    const latestPoolQuality = poolQualityRows.at(-1);
    const poolQualityScore = latestPoolQuality?.score == null ? null : Number(latestPoolQuality.score);
    const result = buildAccountPriorityPlan({ ...ranking, accounts, poolQualityScore }, this.config);
    return { ...result, refreshedAt: new Date().toISOString() };
  }

  private async verifyPriorities(
    priorities: Record<string, number>,
    timeoutMs = this.config.operations.priorityVerificationTimeoutMs,
  ) {
    const expected = new Map(Object.entries(priorities).map(([id, priority]) => [id, Number(priority)]));
    const expectedIds = [...expected.keys()].map((id) => Number(id));
    if (expectedIds.some((id) => !Number.isInteger(id) || id < 1)) {
      throw new Error("priority verification requires stable numeric account IDs");
    }
    const expectedIdsCsv = expectedIds.join(",");
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(0, timeoutMs);
    let verifiedCount = 0;
    let unmatchedPriorities = { ...priorities };
    do {
      const query = await this.reads.query<Record<string, unknown>>({
        key: JSON.stringify(["priorities.verify", expectedIdsCsv]),
        kind: "priorities.verify",
        sql: prioritiesByIdSql,
        parameters: [expectedIdsCsv],
        priority: "manual",
        cacheMode: "bypass-cache",
      });
      const actual = new Map(query.rows.map((row) => [
        String(row.id),
        Number(row.priority),
      ]));
      const oauthIds = query.rows
        .filter((row) => String(row.account_type ?? "").trim().toLowerCase() === "oauth")
        .map((row) => String(row.id));
      if (oauthIds.length > 0) {
        throw new Error(`priority verification rejected OAuth accounts: ${oauthIds.join(",")}`);
      }
      verifiedCount = [...expected].filter(([id, priority]) => actual.get(id) === priority).length;
      unmatchedPriorities = Object.fromEntries(
        [...expected].filter(([id, priority]) => actual.get(id) !== priority),
      );
      if (verifiedCount === expected.size) {
        return {
          complete: true,
          verification: "native-api-read-broker",
          verifiedCount,
          verificationDurationMs: Date.now() - startedAt,
          unmatchedPriorities: {},
        };
      }
      if (Date.now() < deadline) await Bun.sleep(this.config.operations.priorityVerificationPollMs);
    } while (Date.now() < deadline);
    return {
      complete: false,
      verification: "native-api-read-broker",
      verifiedCount,
      verificationDurationMs: Date.now() - startedAt,
      unmatchedPriorities,
    };
  }

  private async writePriorityBatch(priorities: Record<string, number>) {
    if (!this.runtime) throw new Error("Api2Business Sub2API runtime mutation service 不可用");
    const startedAt = Date.now();
    try {
      await this.runtime.updatePriorities(
        priorities,
        this.config.operations.priorityWrite.requestTimeoutMs,
      );
      return { ok: true, exitCode: 0, timedOut: false, writeDurationMs: Date.now() - startedAt, outputAvailable: true, error: "" };
    } catch (error) {
      return { ok: false, exitCode: 1, timedOut: false, writeDurationMs: Date.now() - startedAt, outputAvailable: false,
        error: (error instanceof Error ? error.message : String(error)).slice(-1000) };
    }
  }

  private async applyPriorityBatch(
    priorities: Record<string, number>,
    batchNumber: number,
    batchCount: number,
  ): Promise<Record<string, unknown> & { ok: boolean }> {
    const policy = this.config.operations.priorityWrite;
    const attempts: Array<Record<string, unknown>> = [];
    const preflight = await this.verifyPriorities(priorities, 0);
    const preflightVerifiedCount = Number(preflight.verifiedCount);
    if (preflight.complete) {
      return {
        ok: true,
        batchNumber,
        batchCount,
        changedCount: Object.keys(priorities).length,
        attemptCount: 0,
        retryCount: 0,
        reconciled: true,
        verification: "native-api-read-broker",
        verifiedCount: preflightVerifiedCount,
        preflightVerifiedCount,
        attempts,
      };
    }
    let pending = preflight.unmatchedPriorities;
    let reconciled = preflightVerifiedCount > 0;
    for (let attempt = 1; attempt <= policy.maximumRetries + 1; attempt += 1) {
      const write = await this.writePriorityBatch(pending);
      let verification = await this.verifyPriorities(priorities);
      const attemptResult: Record<string, unknown> = {
        attempt,
        requestedCount: Object.keys(pending).length,
        exitCode: write.exitCode,
        timedOut: write.timedOut,
        writeDurationMs: write.writeDurationMs,
        outputAvailable: write.outputAvailable,
        error: write.error,
        verifiedCount: verification.verifiedCount,
        verificationDurationMs: verification.verificationDurationMs,
        complete: verification.complete,
      };
      attempts.push(attemptResult);
      if (verification.complete) {
        reconciled ||= !write.ok;
        return {
          ok: true,
          batchNumber,
          batchCount,
          changedCount: Object.keys(priorities).length,
          attemptCount: attempt,
          retryCount: attempt - 1,
          reconciled,
          verification: "native-api-read-broker",
          verifiedCount: verification.verifiedCount,
          preflightVerifiedCount,
          attempts,
        };
      }
      if (attempt > policy.maximumRetries) {
        return {
          ok: false,
          batchNumber,
          batchCount,
          changedCount: Object.keys(priorities).length,
          attemptCount: attempt,
          retryCount: attempt - 1,
          reconciled,
          verification: "native-api-read-broker",
          verifiedCount: verification.verifiedCount,
          preflightVerifiedCount,
          unmatchedCount: Object.keys(verification.unmatchedPriorities).length,
          failure: write.timedOut ? "write-timeout-and-verification-incomplete" : "write-or-verification-failed",
          attempts,
        };
      }
      const backoffDelayMs = exponentialRetryDelayMs(
        policy.retryInitialDelayMs,
        attempt,
        policy.retryJitterPercent,
      );
      attemptResult.backoffDelayMs = backoffDelayMs;
      await Bun.sleep(backoffDelayMs);
      verification = await this.verifyPriorities(priorities, 0);
      if (verification.complete) {
        return {
          ok: true,
          batchNumber,
          batchCount,
          changedCount: Object.keys(priorities).length,
          attemptCount: attempt,
          retryCount: attempt - 1,
          reconciled: true,
          verification: "native-api-read-broker",
          verifiedCount: verification.verifiedCount,
          preflightVerifiedCount,
          attempts,
        };
      }
      pending = verification.unmatchedPriorities;
    }
    throw new Error("priority batch retry loop exhausted unexpectedly");
  }

  async confirmPriorityPlan(id: string, operator: string) {
    return await this.store.withPriorityOptimizationQueue(async (queue) => {
      const pendingPlan = await this.store.getPlan(id);
      if (pendingPlan.status !== "pending") throw new Error("priority plan is not pending");
      if (new Date(String(pendingPlan.expires_at)).getTime() <= Date.now()) {
        throw new Error("priority plan has expired");
      }
      await this.store.markPlanExecutionStarted(id);
      return await this.confirmPriorityPlanQueued(id, operator, queue);
    });
  }

  private async confirmPriorityPlanQueued(
    id: string,
    operator: string,
    queue: PriorityOptimizationQueueLease,
  ) {
    const plan = await this.store.getPlan(id);
    if (plan.status !== "pending") throw new Error("priority plan is not pending");
    if (new Date(String(plan.expires_at)).getTime() <= Date.now()) throw new Error("priority plan has expired");
    const priorities = object(plan.priorities) as Record<string, number>;
    const planResult = object(plan.result);
    const profileQueues = buildPriorityWriteProfileQueues(
      { priorities, changes: planResult.changes },
      this.config.operations.priorityWrite.batchSize,
    );
    const batches = profileQueues.flatMap((profileQueue) => profileQueue.batches);
    const profiles = profileQueues.map((profileQueue) => profileQueue.profile);
    const batchResults: Array<Record<string, unknown>> = [];
    let completedChangedCount = 0;
    let completedBatchCount = 0;
    for (const profileQueue of profileQueues) {
      for (let profileBatchIndex = 0; profileBatchIndex < profileQueue.batches.length; profileBatchIndex += 1) {
        const interBatchDelayMs = completedBatchCount === 0
          ? 0
          : randomIntervalMs(
            this.config.operations.priorityWrite.interBatchMinimumDelayMs,
            this.config.operations.priorityWrite.interBatchMaximumDelayMs,
          );
        if (interBatchDelayMs > 0) await Bun.sleep(interBatchDelayMs);
        const batchResult = await this.applyPriorityBatch(
          profileQueue.batches[profileBatchIndex]!,
          completedBatchCount + 1,
          batches.length,
        );
        batchResults.push({
          ...batchResult,
          profile: profileQueue.profile,
          profileBatchNumber: profileBatchIndex + 1,
          profileBatchCount: profileQueue.batches.length,
          interBatchDelayMs,
        });
        if (!batchResult.ok) {
          const result = {
            changedCount: Object.keys(priorities).length,
            completedChangedCount,
            writeMode: "backend-api-paced",
            queue,
            profiles,
            failedProfile: profileQueue.profile,
            batchSize: this.config.operations.priorityWrite.batchSize,
            batchCount: batches.length,
            completedBatchCount,
            maximumRetries: this.config.operations.priorityWrite.maximumRetries,
            verification: "native-api-read-broker",
            batches: batchResults,
          };
          const completion = await this.store.finishPlan(
            id,
            "failed",
            result,
            this.config.operations.automationJitterPercent,
          );
          await this.store.audit("priority.plan.confirm", "failed", operator,
            { planId: id, changedCount: Object.keys(priorities).length },
            {
              writeMode: "backend-api-paced",
              queueName: queue.queueName,
              queueWaitMs: queue.waitMs,
              profiles,
              failedProfile: profileQueue.profile,
              batchCount: batches.length,
              completedBatchCount,
              failedBatchNumber: completedBatchCount + 1,
              verification: "native-api-read-broker",
              nextAutomaticRunAt: completion.next_run_at,
            });
          throw new Error("优先级分轮写入重试耗尽，已停止后续轮次");
        }
        completedChangedCount += Number(batchResult.changedCount);
        completedBatchCount += 1;
      }
    }
    const result = {
      changedCount: Object.keys(priorities).length,
      completedChangedCount,
      writeMode: "backend-api-paced",
      queue,
      profiles,
      batchSize: this.config.operations.priorityWrite.batchSize,
      batchCount: batches.length,
      completedBatchCount: batches.length,
      maximumRetries: this.config.operations.priorityWrite.maximumRetries,
      verification: "native-api-read-broker",
      verifiedCount: completedChangedCount,
      batches: batchResults,
    };
    const completion = await this.store.finishPlan(
      id,
      "applied",
      result,
      this.config.operations.automationJitterPercent,
    );
    await this.store.audit("priority.plan.confirm", "succeeded", operator,
      { planId: id, changedCount: Object.keys(priorities).length },
      {
        writeMode: "backend-api-paced",
        queueName: queue.queueName,
        queueWaitMs: queue.waitMs,
        profiles,
        batchCount: batches.length,
        completedBatchCount: batches.length,
        verification: "native-api-read-broker",
        verifiedCount: completedChangedCount,
      });
    return {
      ok: true,
      planId: id,
      ...result,
      executionStartedAt: completion.execution_started_at,
      completedAt: completion.completed_at,
      nextAutomaticRunAt: completion.next_run_at,
    };
  }

  async priorityHistory() {
    const rows = await this.store.priorityHistory(this.config.operations.auditLimit) as Array<Record<string, unknown>>;
    return {
      ok: true,
      records: rows.map((row) => {
        const priorities = typeof row.priorities === "string" ? JSON.parse(row.priorities) : row.priorities;
        const result = typeof row.result === "string" ? JSON.parse(row.result) : object(row.result);
        const applyResult = typeof row.apply_result === "string"
          ? JSON.parse(row.apply_result)
          : object(row.apply_result);
        const automationSafety = object(object(result).automationSafety);
        const {
          priorities: _hidden,
          result: _hiddenResult,
          apply_result: _hiddenApplyResult,
          ...visible
        } = row;
        const priorityIds = new Set(
          priorities && typeof priorities === "object" && !Array.isArray(priorities)
            ? Object.keys(priorities)
            : [],
        );
        const changes = records(object(result).changes);
        const profileSummary = object(object(result).profiles);
        const discoveredProfiles = new Set([
          ...Object.keys(profileSummary),
          ...changes.map((change) => String(change.profile ?? "")).filter(Boolean),
        ]);
        const profiles = ["codex", "grok"].filter((profile) => discoveredProfiles.has(profile));
        if (profiles.length === 0) profiles.push("codex");
        const startedAt = row.execution_started_at ?? row.created_at;
        const completedAt = row.completed_at;
        const startedAtMs = startedAt instanceof Date
          ? startedAt.getTime()
          : new Date(String(startedAt)).getTime();
        const completedAtMs = completedAt instanceof Date
          ? completedAt.getTime()
          : new Date(String(completedAt)).getTime();
        const durationMs = row.duration_ms !== null && row.duration_ms !== undefined
          ? Math.max(0, Number(row.duration_ms))
          : completedAt && Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
            ? Math.max(0, completedAtMs - startedAtMs)
            : null;
        const batches = records(object(applyResult).batches);
        const profileChangedCounts: Record<string, number> = {};
        const profileCandidateChangedCounts: Record<string, number> = {};
        const profileNotSelectedChangedCounts: Record<string, number> = {};
        const profileWriteBatchCounts: Record<string, number> = {};
        const profileStatuses: Record<string, unknown> = {};
        for (const profile of profiles) {
          const profileChanges = changes.filter((change) => String(change.profile ?? "codex") === profile);
          const changedCount = profileChanges.filter((change) =>
            priorityIds.has(String(change.accountId ?? change.account_id ?? "")),
          ).length;
          const candidateChangedCount = Number(
            object(profileSummary[profile]).changedCount ?? profileChanges.length,
          );
          const profileBatches = batches.filter((batch) => String(batch.profile ?? "") === profile);
          let profileStatus = row.status;
          if (row.status === "failed" && profileBatches.length > 0) {
            profileStatus = profileBatches.some((batch) => batch.ok === false) ? "failed" : "applied";
          } else if (row.status === "failed" && profileBatches.length === 0 && changedCount > 0) {
            profileStatus = "skipped";
          }
          profileChangedCounts[profile] = changedCount;
          profileCandidateChangedCounts[profile] = candidateChangedCount;
          profileNotSelectedChangedCounts[profile] = Math.max(0, candidateChangedCount - changedCount);
          profileWriteBatchCounts[profile] = profileBatches.length;
          profileStatuses[profile] = profileStatus;
        }
        return {
          ...visible,
          id: String(row.id),
          profile: profiles.length === 1 ? profiles[0] : "combined",
          profiles,
          status: row.status,
          started_at: startedAt,
          duration_ms: durationMs,
          changed_count: priorityIds.size,
          candidate_changed_count: Object.values(profileCandidateChangedCounts)
            .reduce((sum, value) => sum + value, 0),
          not_selected_changed_count: Object.values(profileNotSelectedChangedCounts)
            .reduce((sum, value) => sum + value, 0),
          profile_changed_counts: profileChangedCounts,
          profile_candidate_changed_counts: profileCandidateChangedCounts,
          profile_not_selected_changed_counts: profileNotSelectedChangedCounts,
          profile_write_batch_counts: profileWriteBatchCounts,
          profile_statuses: profileStatuses,
          automation_mode: automationSafety.mode ?? null,
          automation_batching_reasons: automationSafety.batchingReasons ?? [],
          automation_write_batch_size: Number(automationSafety.writeBatchSize ?? 0),
          automation_write_batch_count: batches.length,
        };
      }),
    };
  }

  async getPriorityAutomation() {
    return { ok: true, automation: await this.store.getAutomation() };
  }

  private validateAutomation(input: { enabled: unknown; intervalSeconds: unknown; recentCallLimit: unknown }) {
    const enabled = input.enabled;
    const intervalSeconds = Number(input.intervalSeconds);
    const recentCallLimit = Number(input.recentCallLimit);
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 86400) {
      throw new Error("intervalSeconds must be an integer from 5 to 86400");
    }
    if (!this.config.monitor.recentCallOptions.includes(recentCallLimit)) {
      throw new Error("recentCallLimit is not declared in owning YAML");
    }
    return { enabled, intervalSeconds, recentCallLimit };
  }

  async createPriorityAutomation(input: { enabled: unknown; intervalSeconds: unknown; recentCallLimit: unknown }, operator: string) {
    const values = this.validateAutomation(input);
    const automation = await this.store.createAutomation({
      ...values, operator, jitterPercent: this.config.operations.automationJitterPercent,
    });
    await this.store.audit("priority.automation.create", "succeeded", operator, values, { intervalSeconds: values.intervalSeconds });
    return { ok: true, automation };
  }

  async updatePriorityAutomation(input: { enabled: unknown; intervalSeconds: unknown; recentCallLimit: unknown }, operator: string) {
    const values = this.validateAutomation(input);
    const automation = await this.store.updateAutomation({
      ...values, operator, jitterPercent: this.config.operations.automationJitterPercent,
    });
    await this.store.audit("priority.automation.update", "succeeded", operator, values, { intervalSeconds: values.intervalSeconds });
    return { ok: true, automation };
  }

  async deletePriorityAutomation(operator: string) {
    await this.store.deleteAutomation();
    await this.store.audit("priority.automation.delete", "succeeded", operator, {}, { deleted: true });
    return { ok: true, deleted: true };
  }

  async priorityAutomationDispatchState() {
    const row = await this.store.getAutomation();
    if (!row) return null;
    return {
      enabled: row.enabled === true,
      nextRunAt: row.next_run_at ?? null,
      runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
      runClaimedAt: row.run_claimed_at ?? null,
      runStartedAt: row.run_started_at ?? null,
    };
  }

  async priorityAutomationDispatchDelay() {
    return automationDispatchDelayMs(
      await this.priorityAutomationDispatchState(),
      Date.now(),
      this.config.operations.automationRunTimeoutMs,
      this.config.operations.automationPollMs,
    );
  }

  async deferPriorityAutomationAfterDispatchFailure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return await this.store.deferDueAutomationAfterDispatchFailure(
      this.config.operations.automationJitterPercent,
      message.slice(0, 500),
    );
  }

  async runDueAutomation() {
    const policy = await this.store.claimDueAutomation(
      this.config.operations.automationRunTimeoutMs,
      this.config.operations.automationJitterPercent,
    );
    if (!policy) return { ok: true, due: false };
    if (policy.recovered) {
      return {
        ok: true,
        due: false,
        recovered: true,
        planId: policy.plan_id,
        writeMode: policy.writeMode,
        reason: policy.reason,
        nextRunAt: policy.next_run_at,
        completedAt: policy.last_completed_at,
      };
    }
    const operator = "scheduler";
    const runId = String(policy.run_id);
    let enteredQueue = false;
    try {
      return await this.store.withPriorityOptimizationQueue(async (queue) => {
        enteredQueue = true;
        let plan: Record<string, unknown> | null = null;
        let completionStatus = "failed";
        let runError: unknown = null;
        try {
          const started = await this.store.markAutomationRunStarted(runId);
          const startedAt = started.run_started_at instanceof Date
            ? started.run_started_at.toISOString()
            : new Date(String(started.run_started_at)).toISOString();
          plan = await this.generatePriorityPlanQueued(
            Number(policy.recent_call_limit),
            operator,
            "automatic",
            startedAt,
            queue,
          );
          const safety = object(plan.automationSafety);
          if (safety.allowed !== true) {
            const result = {
              changedCount: 0,
              candidateChangedCount: Number(plan.candidateChangedCount ?? 0),
              notSelectedChangedCount: Number(plan.notSelectedChangedCount ?? 0),
              writeMode: "cycle-skipped",
              verification: "not-started",
              safety,
              profiles: plan.profiles,
              queue,
            };
            await this.store.finishPlan(
              String(plan.planId),
              "failed",
              result,
              this.config.operations.automationJitterPercent,
            );
            await this.store.audit("priority.automation.run", "blocked", operator,
              { recentCallLimit: Number(policy.recent_call_limit), jitterPercent: this.config.operations.automationJitterPercent },
              { planId: plan.planId, ...result });
            completionStatus = "skipped";
            return { ok: true, due: true, planId: plan.planId, ...result };
          }
          if (Number(plan.changedCount) === 0) {
            const result = {
              changedCount: 0,
              candidateChangedCount: Number(plan.candidateChangedCount ?? 0),
              notSelectedChangedCount: Number(plan.notSelectedChangedCount ?? 0),
              automationMode: safety.mode ?? "full",
              writeMode: "no-change",
              verification: "native-api-read-broker",
              verifiedCount: 0,
              queue,
            };
            await this.store.finishPlan(
              String(plan.planId),
              "applied",
              result,
              this.config.operations.automationJitterPercent,
            );
            await this.store.audit("priority.automation.run", "succeeded", operator,
              { recentCallLimit: Number(policy.recent_call_limit), jitterPercent: this.config.operations.automationJitterPercent },
              { ...result, profiles: plan.profiles });
            completionStatus = "succeeded";
            return { ok: true, due: true, planId: plan.planId, ...result };
          }
          const result = await this.confirmPriorityPlanQueued(
            String(plan.planId),
            operator,
            queue,
          );
          const batch = {
            candidateChangedCount: Number(plan.candidateChangedCount ?? result.changedCount),
            notSelectedChangedCount: Number(plan.notSelectedChangedCount ?? 0),
            automationMode: safety.mode ?? "full",
          };
          await this.store.audit("priority.automation.run", "succeeded", operator,
            { recentCallLimit: Number(policy.recent_call_limit), jitterPercent: this.config.operations.automationJitterPercent },
            {
              planId: plan.planId,
              changedCount: result.changedCount,
              verification: result.verification,
              profiles: plan.profiles,
              queueName: queue.queueName,
              queueWaitMs: queue.waitMs,
              ...batch,
            });
          completionStatus = "succeeded";
          return { due: true, ...result, ...batch };
        } catch (error) {
          runError = error;
          completionStatus = "failed";
          try {
            await this.store.audit("priority.automation.run", "failed", operator,
              { recentCallLimit: Number(policy.recent_call_limit), jitterPercent: this.config.operations.automationJitterPercent },
              {
                planId: plan?.planId ?? null,
                queueName: queue.queueName,
                queueWaitMs: queue.waitMs,
                error: error instanceof Error ? error.message : String(error),
              });
          } catch (auditError) {
            console.error(JSON.stringify({
              component: "priority-automation",
              event: "failure-audit-failed",
              error: auditError instanceof Error ? auditError.message : String(auditError),
              valuesPrinted: false,
            }));
          }
          throw error;
        } finally {
          try {
            const completed = await this.store.completeAutomationRun(
              runId,
              this.config.operations.automationJitterPercent,
              completionStatus,
            );
            if (!completed) throw new Error("priority automation run token no longer exists");
          } catch (completionError) {
            if (runError === null) throw completionError;
            console.error(JSON.stringify({
              component: "priority-automation",
              event: "run-completion-failed",
              error: completionError instanceof Error ? completionError.message : String(completionError),
              valuesPrinted: false,
            }));
          }
        }
      });
    } catch (error) {
      if (enteredQueue) throw error;
      try {
        await this.store.audit("priority.automation.run", "failed", operator,
          { recentCallLimit: Number(policy.recent_call_limit), jitterPercent: this.config.operations.automationJitterPercent },
          {
            planId: null,
            queueName: "priority-optimization-global",
            queueAcquired: false,
            error: error instanceof Error ? error.message : String(error),
          });
      } catch (auditError) {
        console.error(JSON.stringify({
          component: "priority-automation",
          event: "failure-audit-failed",
          error: auditError instanceof Error ? auditError.message : String(auditError),
          valuesPrinted: false,
        }));
      }
      try {
        const completed = await this.store.completeAutomationRun(
          runId,
          this.config.operations.automationJitterPercent,
          "failed",
        );
        if (!completed) throw new Error("priority automation run token no longer exists");
      } catch (completionError) {
        console.error(JSON.stringify({
          component: "priority-automation",
          event: "run-completion-failed",
          error: completionError instanceof Error ? completionError.message : String(completionError),
          valuesPrinted: false,
        }));
      }
      throw error;
    }
  }

  async procurement(budgetCny: number, operator: string, page = 1, pageSize = 10) {
    const ranking = await collectRecentCallScoresFromDatabase(
      this.config,
      this.config.monitor.recentCallLimit,
      this.reads,
      null,
      null,
      "manual",
    );
    const priority = buildAccountPriorityPlan(ranking, this.config);
    const candidates = records((priority.procurementAdvice as Record<string, unknown>)?.recommendations);
    const denominations = [...this.config.operations.rechargeDenominationsCny].sort((a, b) => b - a);
    let remaining = budgetCny;
    const allocations: Array<{ billingSite: string; amountCny: number; denominationCny: number }> = [];
    let cursor = 0;
    while (remaining > 0 && candidates.length > 0) {
      const denomination = denominations.find((value) => value <= remaining);
      if (!denomination) break;
      const candidate = candidates[cursor % candidates.length]!;
      allocations.push({ billingSite: String(candidate.billingSite), amountCny: denomination, denominationCny: denomination });
      remaining -= denomination;
      cursor += 1;
    }
    const total = allocations.length;
    const result = {
      ok: true, budgetCny, allocatedCny: budgetCny - remaining, unallocatedCny: remaining,
      allocations: allocations.slice((page - 1) * pageSize, page * pageSize),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
      deterministic: true, llmCalls: 0,
    };
    if (page === 1) {
      await this.store.audit("procurement.calculate", "succeeded", operator,
        { budgetCny }, { allocatedCny: result.allocatedCny, unallocatedCny: remaining, siteCount: new Set(allocations.map((row) => row.billingSite)).size });
    }
    return result;
  }

  readStatus() {
    return {
      ok: true,
      readExecutor: this.reads.status(),
    };
  }

  async errorAggregate(
    limit: number,
    top: number,
    accountSelector: string | null,
    groupSelector: string | null,
  ) {
    return await collectErrorAggregateFromDatabase(
      this.config,
      this.reads,
      limit,
      top,
      accountSelector,
      groupSelector,
      "manual",
    );
  }

  async errorDiagnose(
    limit: number,
    top: number,
    accountSelector: string | null,
    groupSelector: string | null,
    failoverRequestIds: string[] | null,
  ) {
    return await collectErrorDiagnosisFromDatabase(
      this.config,
      this.reads,
      limit,
      top,
      accountSelector,
      groupSelector,
      failoverRequestIds,
      "manual",
    );
  }

  async errorList(limit: number) {
    return await collectErrorListFromDatabase(
      this.config,
      this.reads,
      limit,
      "manual",
    );
  }

  async errorRequest(requestId: string) {
    return await collectErrorRequestFromDatabase(
      this.config,
      this.reads,
      requestId,
      "manual",
    );
  }

  async userImpact(
    start: string,
    end: string,
    affectedOnly: boolean,
  ) {
    return await collectUserImpactFromDatabase(
      this.config,
      this.reads,
      start,
      end,
      affectedOnly,
      "manual",
    );
  }

  async accountBatchEconomics(input: AccountBatchEconomicsInput) {
    return await collectAccountBatchEconomics(
      this.config,
      this.reads,
      input,
      "manual",
    );
  }

  async accountImportEconomics(input: AccountImportEconomicsInput) {
    return await collectAccountImportEconomics(this.config, this.reads, input, "manual");
  }

  async oauthPoolEconomics(
    page = 1,
    pageSize = 10,
    archivedPage = 1,
    profile: "codex" | "grok" = "codex",
    priority: Sub2ApiReadPriority = "manual",
  ) {
    const yaml = this.yamlLedger();
    const importEntries = readAccountImportCosts(this.config.operations.accountImportLedgerPath);
    const merged = mergeOAuthAcquisitionCosts(importEntries, yaml.costs);
    const refunds = normalizeOAuthRefunds(yaml.revenues);
    const jsonlCostCny = importEntries.reduce((sum, entry) => sum + money(entry.amountCny), 0);
    const yamlAcquisitionCostCny = yaml.costs
      .filter((entry) => entry.kind === "acquisition")
      .reduce((sum, entry) => sum + money(entry.amountCny), 0);
    const grok = profile === "grok";
    const result = await collectOAuthPoolEconomics(this.config, this.reads, {
      costs: grok ? [] : merged.costs,
      refunds: grok ? [] : refunds,
      excludedAccountIds: grok ? [] : this.config.operations.oauthEconomics.excludedAccountIds,
      profile,
      syntheticUnitCostCny: grok ? 0.02 : undefined,
      ledger: {
        jsonlEntryCount: merged.jsonlEntryCount,
        jsonlCostCny: money(jsonlCostCny),
        yamlAcquisitionEntryCount: merged.yamlEntryCount,
        yamlAcquisitionCostCny: money(yamlAcquisitionCostCny),
        yamlSuppressedDuplicateCount: merged.yamlSuppressedCount,
        mergedCostAccountCount: grok ? 0 : merged.costs.length,
        syntheticUnitCostCny: grok ? 0.02 : null,
      },
    }, priority);
    const paginate = (rows: Array<Record<string, unknown>>, currentPage: number) => ({
      rows: rows.slice((currentPage - 1) * pageSize, currentPage * pageSize),
      pagination: {
        page: currentPage,
        pageSize,
        total: rows.length,
        totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
      },
    });
    const poolFacts = result.pool as Record<string, unknown> & { groups: Array<Record<string, unknown>> };
    const archivedFacts = result.archived as Record<string, unknown> & { groups: Array<Record<string, unknown>> };
    const poolPage = paginate(poolFacts.groups, page);
    const archivedResult = paginate(archivedFacts.groups, archivedPage);
    return {
      ...result,
      pool: { ...poolFacts, groups: poolPage.rows, pagination: poolPage.pagination },
      archived: { ...archivedFacts, groups: archivedResult.rows, pagination: archivedResult.pagination },
      groups: poolPage.rows,
      pagination: poolPage.pagination,
    };
  }

  async oauthImportEconomics(day: string, page = 1, pageSize = 10) {
    const yaml = this.yamlLedger();
    const externalCosts = yaml.costs
      .filter((entry) => entry.kind === "acquisition" && entry.occurredOn === day)
      .map((entry) => ({ accountId: Number(entry.accountId), costCny: money(entry.amountCny) }));
    const facts = await collectAccountImportEconomics(
      this.config,
      this.reads,
      { day, externalCosts },
      "manual",
    );
    const total = facts.total as Record<string, unknown>;
    const grossAcquisitionCostCny = money(total.acquisitionCostCny);
    const refunds = yaml.revenues
      .filter((entry) => entry.kind === "procurement-refund" && entry.occurredOn === day);
    const procurementRefundCny = refunds
      .reduce((sum, entry) => sum + money(entry.amountCny), 0);
    const netAcquisitionCostCny = Math.max(0, grossAcquisitionCostCny - procurementRefundCny);
    const apiAmountUsd = Number(total.apiAmountUsd);
    const groups = applyPlanTypeRefunds(Array.isArray(facts.groups) ? facts.groups : [], refunds);
    return {
      ...facts,
      groups: groups.slice((page - 1) * pageSize, page * pageSize),
      pagination: { page, pageSize, total: groups.length, totalPages: Math.max(1, Math.ceil(groups.length / pageSize)) },
      total: {
        ...total,
        grossAcquisitionCostCny,
        procurementRefundCny,
        netAcquisitionCostCny,
        acquisitionCostCny: netAcquisitionCostCny,
        cnyPerApiUsd: apiAmountUsd > 0 ? netAcquisitionCostCny / apiAmountUsd : null,
      },
      accountingBasis: "openai-oauth-net-acquisition-cost",
    };
  }

  async audits(page = 1, pageSize = 10) {
    const rows = await this.store.audits(pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    const total = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : await this.store.auditCount();
    return { ok: true, records: rows, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
  }
}
