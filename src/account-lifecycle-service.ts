import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AppConfig } from "./config";
import { readAccountImportCosts } from "./account-import-cost-ledger";
import { parseAccountEconomicsWindow } from "./account-batch-economics";
import { recordLifecycleSettlement } from "./account-lifecycle-ledger";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import type { TemporalGateway } from "./temporal-client";
import type { Sub2ApiRuntimeService } from "./sub2api-runtime-service";
import { parse } from "yaml";

type PlanType = "k12" | "plus" | "free" | "team" | "all";
type LifecycleScope = "day" | "pool";
type SelectionMode = "probe" | "database-error" | "database-dead" | "database-all";
type JobState = "queued" | "running" | "succeeded" | "settling" | "settled" | "failed";
type Row = Record<string, unknown>;

export interface LifecycleRequest {
  day: string;
  planType: PlanType;
  model?: string;
  confirm: boolean;
  selectionMode?: SelectionMode;
  scope?: LifecycleScope;
}

export interface LifecycleJob {
  id: string;
  state: JobState;
  createdAt: string;
  completedAt: string | null;
  settings: { day: string; planType: PlanType; model: string; confirm: boolean; selectionMode: SelectionMode; scope: LifecycleScope };
  fingerprint: string | null;
  logs: Array<{ timestamp: string; stage: string; state: string; message: string }>;
  candidates: Row[];
  result: Row | null;
  settlement: Row | null;
  error: string | null;
  workflow?: { workflowId: string; runId: string; state: "submitted" };
}

export interface LifecycleJobPatch {
  state?: JobState;
  completedAt?: string | null;
  fingerprint?: string | null;
  logs?: Array<{ timestamp: string; stage: string; state: string; message: string }>;
  candidates?: Row[];
  result?: Row | null;
  settlement?: Row | null;
  error?: string | null;
}

export interface LifecycleJobControl {
  get(id: string): Promise<LifecycleJob | null>;
  patch(id: string, patch: LifecycleJobPatch): Promise<void>;
}

const candidateSql = `
WITH cost_input AS (
  SELECT account_id, cost_cny
  FROM unnest(
    string_to_array($1::text, ',')::bigint[],
    string_to_array($2::text, ',')::numeric[]
  ) AS item(account_id, cost_cny)
), usage_totals AS (
  SELECT usage.account_id, COUNT(*)::bigint AS request_count,
    COALESCE(SUM(usage.input_tokens + usage.output_tokens), 0)::bigint AS token_count,
    COALESCE(SUM(usage.actual_cost), 0)::numeric AS api_amount_usd
  FROM usage_logs usage
  JOIN cost_input cost ON cost.account_id = usage.account_id
  WHERE usage.created_at >= $3::timestamptz AND usage.created_at < $4::timestamptz
  GROUP BY usage.account_id
)
SELECT cost.account_id, cost.cost_cny,
  (account.id IS NOT NULL) AS exists,
  account.platform, account.type,
  COALESCE(NULLIF(LOWER(account.credentials->>'plan_type'), ''), 'unknown') AS plan_type,
  account.status, COALESCE(account.schedulable, false) AS schedulable,
  account.rate_limit_reset_at, account.overload_until, account.temp_unschedulable_until,
  CASE
    WHEN account.rate_limit_reset_at IS NOT NULL AND account.rate_limit_reset_at > NOW() THEN 'rate_limited'
    WHEN account.status = 'active' AND COALESCE(account.schedulable, false)
      AND (account.overload_until IS NULL OR account.overload_until <= NOW())
      AND (account.temp_unschedulable_until IS NULL OR account.temp_unschedulable_until <= NOW()) THEN 'normal'
    ELSE 'error'
  END AS state_bucket,
  COALESCE(usage.request_count, 0)::bigint AS request_count,
  COALESCE(usage.token_count, 0)::bigint AS token_count,
  COALESCE(usage.api_amount_usd, 0)::numeric AS api_amount_usd
FROM cost_input cost
LEFT JOIN accounts account ON account.id = cost.account_id AND account.deleted_at IS NULL
LEFT JOIN usage_totals usage ON usage.account_id = cost.account_id
ORDER BY cost.account_id`;

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

export function readLifecycleAcquisitionCosts(config: AppConfig, day: string | null): Array<{ accountId: number; costCny: number }> {
  const root = parse(readFileSync(config.operations.ledgerYamlPath, "utf8")) as Record<string, unknown>;
  const profit = root.profit && typeof root.profit === "object" && !Array.isArray(root.profit)
    ? root.profit as Record<string, unknown>
    : {};
  return records(profit.periodCosts)
    .filter((entry) => entry.kind === "acquisition" && (day === null || entry.occurredOn === day))
    .map((entry) => ({ accountId: positiveInteger(entry.accountId), costCny: number(entry.amountCny) }))
    .filter((entry): entry is { accountId: number; costCny: number } => entry.accountId !== null && entry.costCny >= 0);
}

export function lifecycleRetirementReason(row: Row, selectionMode: SelectionMode): string | null {
  const state = String(row.stateBucket ?? "error");
  const planType = String(row.planType ?? "unknown");
  if (selectionMode === "database-all") return "database-all";
  if (selectionMode === "database-error") return state === "error" ? "database-error" : null;
  if (selectionMode !== "database-dead") return null;
  if (state === "error") return "database-error";
  if (state === "rate_limited" && (planType === "free" || planType === "plus")) return "database-rate-limited";
  return null;
}

function mergeLifecycleCosts(
  automatic: Array<{ accountId: number; costCny: number }>,
  declared: Array<{ accountId: number; costCny: number }>,
): Array<{ accountId: number; costCny: number }> {
  const merged = new Map<number, number>();
  for (const entry of [...automatic, ...declared]) {
    const previous = merged.get(entry.accountId);
    if (previous !== undefined && Math.abs(previous - entry.costCny) > 1e-8) {
      throw new Error(`账号 ${entry.accountId} 的生命周期采购成本在 JSONL 与 owning YAML 中冲突`);
    }
    merged.set(entry.accountId, entry.costCny);
  }
  return [...merged.entries()].sort(([left], [right]) => left - right).map(([accountId, costCny]) => ({ accountId, costCny }));
}

function safeMessage(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/rt\.\d\.[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_.-]+/gu, "[REDACTED]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/gu, "[REDACTED]").slice(0, 500);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); }
  catch { return String(error); }
}

export class AccountLifecycleService {
  private jobs = new Map<string, LifecycleJob>();

  constructor(
    private config: AppConfig,
    private reads: Sub2ApiReadClient,
    private temporal: TemporalGateway | null = null,
    private workerJobs: LifecycleJobControl | null = null,
    private runtime: Sub2ApiRuntimeService | null = null,
  ) {}

  async submit(input: LifecycleRequest): Promise<LifecycleJob> {
    parseAccountEconomicsWindow({ day: input.day }, this.config.monitor.timezone);
    if (!["k12", "plus", "free", "team", "all"].includes(input.planType)) throw new Error("planType is invalid");
    const selectionMode = input.selectionMode ?? "probe";
    if (selectionMode !== "probe" && selectionMode !== "database-error" && selectionMode !== "database-dead" && selectionMode !== "database-all") throw new Error("selectionMode is invalid");
    const scope = input.scope ?? "day";
    if (scope !== "day" && scope !== "pool") throw new Error("scope is invalid");
    const model = input.model?.trim() || this.config.operations.accountLifecycle.defaultModel;
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(model)) throw new Error("model is invalid");
    const job: LifecycleJob = {
      id: randomUUID(), state: "queued", createdAt: new Date().toISOString(), completedAt: null,
      settings: { day: input.day, planType: input.planType, model, confirm: input.confirm, selectionMode, scope },
      fingerprint: null, logs: [], candidates: [], result: null, settlement: null, error: null,
    };
    this.jobs.set(job.id, job);
    while (this.jobs.size > 20) this.jobs.delete(this.jobs.keys().next().value!);
    if (!this.temporal) {
      job.state = "failed";
      job.error = "Temporal worker 当前不可用";
      this.log(job, "job", "failed", job.error);
      job.completedAt = new Date().toISOString();
      throw new Error(job.error);
    }
    try {
      job.workflow = await this.temporal.submit({ kind: "account.lifecycle.detect", jobId: job.id });
    } catch (error) {
      job.state = "failed";
      job.error = safeMessage(error instanceof Error ? error.message : String(error));
      this.log(job, "job", "failed", job.error);
      job.completedAt = new Date().toISOString();
      throw error;
    }
    return this.project(job);
  }

  get(id: string): LifecycleJob | null {
    const job = this.jobs.get(id);
    return job ? this.project(job) : null;
  }

  workerGet(id: string): LifecycleJob | null { return this.get(id); }

  applyWorkerPatch(id: string, patch: LifecycleJobPatch): Record<string, unknown> {
    const job = this.jobs.get(id);
    if (!job) throw new Error("OAuth 生命周期作业不存在");
    if (patch.state !== undefined) job.state = patch.state;
    if (patch.completedAt !== undefined) job.completedAt = patch.completedAt;
    if (patch.fingerprint !== undefined) job.fingerprint = patch.fingerprint;
    if (patch.logs !== undefined) job.logs = structuredClone(patch.logs);
    if (patch.candidates !== undefined) job.candidates = structuredClone(patch.candidates);
    if (patch.result !== undefined) job.result = patch.result ? structuredClone(patch.result) : null;
    if (patch.settlement !== undefined) job.settlement = patch.settlement ? structuredClone(patch.settlement) : null;
    if (patch.error !== undefined) job.error = patch.error;
    return { ok: true, job: this.project(job), valuesPrinted: false };
  }

  async settle(id: string): Promise<LifecycleJob> {
    const job = this.jobs.get(id);
    if (!job) throw new Error("OAuth 生命周期作业不存在");
    if (job.state !== "succeeded") throw new Error("只有检测成功的作业可以结算");
    const summary = job.result?.summary as Row | undefined;
    if (number(summary?.alive) !== 0 || number(summary?.unknown) !== 0 || number(summary?.dead) !== job.candidates.length) {
      throw new Error("批次并非全部确定死亡，拒绝结算和删除");
    }
    if (!this.temporal) throw new Error("Temporal worker 当前不可用");
    job.state = "settling";
    this.log(job, "settlement", "queued", `开始结算 ${job.candidates.length} 个确定死亡账号`);
    try {
      job.workflow = await this.temporal.submit({
        kind: "account.lifecycle.settle",
        jobId: job.id,
        candidateIds: job.candidates.map((row) => number(row.accountId)),
      });
    } catch (error) {
      job.state = "failed";
      job.error = safeMessage(error instanceof Error ? error.message : String(error));
      this.log(job, "settlement", "failed", job.error);
      job.completedAt = new Date().toISOString();
      throw error;
    }
    return this.project(job);
  }

  async runDetectWorker(id: string): Promise<LifecycleJob> {
    if (!this.workerJobs) throw new Error("OAuth 生命周期 worker job 控制面不可用");
    const job = await this.workerJobs.get(id);
    if (!job) throw new Error("OAuth 生命周期作业不存在");
    if (job.state === "succeeded" || job.state === "settling" || job.state === "settled" || job.state === "failed") return job;
    await this.detect(job);
    return job;
  }

  async runSettlementWorker(id: string, candidateIds: number[]): Promise<LifecycleJob> {
    if (!this.workerJobs) throw new Error("OAuth 生命周期 worker job 控制面不可用");
    const job = await this.workerJobs.get(id);
    if (!job) throw new Error("OAuth 生命周期作业不存在");
    if (job.state === "settled" || job.state === "failed") return job;
    const expectedIds = [...new Set(candidateIds.filter((value) => Number.isSafeInteger(value) && value > 0))]
      .sort((left, right) => left - right);
    if (expectedIds.length === 0) throw new Error("OAuth 生命周期结算缺少已确认的候选账号");
    const snapshotIds = [...new Set(job.candidates.map((row) => number(row.accountId)))]
      .sort((left, right) => left - right);
    if (snapshotIds.length > 0 && JSON.stringify(snapshotIds) !== JSON.stringify(expectedIds)) {
      throw new Error("OAuth 生命周期结算候选与已确认计划不一致");
    }
    // Temporal 命令承载不可变结算快照，避免不完整的 worker 回读覆盖 API 侧计划。
    job.candidates = expectedIds.map((accountId) => ({ accountId }));
    await this.finishSettlement(job, false);
    return job;
  }

  private project(job: LifecycleJob): LifecycleJob { return structuredClone(job); }
  private log(job: LifecycleJob, stage: string, state: string, message: string) {
    job.logs.push({ timestamp: new Date().toISOString(), stage, state, message: safeMessage(message) });
  }

  private async persistWorkerJob(job: LifecycleJob, includeCandidates = true): Promise<void> {
    if (!this.workerJobs) return;
    await this.workerJobs.patch(job.id, {
      state: job.state,
      completedAt: job.completedAt,
      fingerprint: job.fingerprint,
      logs: job.logs,
      ...(includeCandidates ? { candidates: job.candidates } : {}),
      result: job.result,
      settlement: job.settlement,
      error: job.error,
    });
  }

  private async facts(day: string, scope: LifecycleScope): Promise<Row[]> {
    const automaticCosts = readAccountImportCosts(this.config.operations.accountImportLedgerPath)
      .filter((entry) => scope === "pool" || entry.occurredOn === day)
      .map((entry) => ({ accountId: entry.accountId, costCny: entry.amountCny }));
    const costs = mergeLifecycleCosts(automaticCosts, readLifecycleAcquisitionCosts(this.config, scope === "pool" ? null : day));
    if (costs.length === 0) return [];
    const window = scope === "pool"
      ? { startUtc: "1970-01-01T00:00:00.000Z" }
      : parseAccountEconomicsWindow({ day }, this.config.monitor.timezone);
    const end = new Date().toISOString();
    const query = await this.reads.query<Row>({
      key: JSON.stringify(["accounts.lifecycle", day, costs, end]), kind: "accounts.lifecycle",
      sql: candidateSql,
      parameters: [costs.map((item) => item.accountId).join(","), costs.map((item) => item.costCny).join(","), window.startUtc, end],
      priority: "manual", cacheMode: "bypass-cache",
    });
    return query.rows.map((row) => ({
      accountId: number(row.account_id), costCny: number(row.cost_cny), exists: row.exists === true,
      platform: row.platform ?? null, type: row.type ?? null, planType: row.plan_type ?? "unknown",
      status: row.status ?? null, schedulable: row.schedulable === true, stateBucket: row.state_bucket ?? "error",
      rateLimitResetAt: row.rate_limit_reset_at ?? null, overloadUntil: row.overload_until ?? null,
      tempUnschedulableUntil: row.temp_unschedulable_until ?? null,
      requestCount: number(row.request_count), tokenCount: number(row.token_count), apiAmountUsd: number(row.api_amount_usd),
    }));
  }

  private async detect(job: LifecycleJob): Promise<void> {
    try {
      job.state = "running";
      this.log(job, "candidates", "start", `读取 ${job.settings.scope === "pool" ? "当前号池" : job.settings.day} 的 ${job.settings.planType.toUpperCase()} OAuth 候选`);
      await this.persistWorkerJob(job);
      const rows = await this.facts(job.settings.day, job.settings.scope);
      const eligible = rows.filter((row) => row.exists === true && row.platform === "openai" && row.type === "oauth"
        && (job.settings.planType === "all" || row.planType === job.settings.planType));
      if (job.settings.selectionMode === "database-error" || job.settings.selectionMode === "database-dead" || job.settings.selectionMode === "database-all") {
        const rateLimited = eligible.filter((row) => row.stateBucket === "rate_limited");
        job.candidates = eligible.filter((row) => lifecycleRetirementReason(row, job.settings.selectionMode) !== null);
        if (job.candidates.length === 0) throw new Error("没有匹配当前退役策略的账号");
        const accountIds = job.candidates.map((row) => number(row.accountId));
        const byPlanType = Object.fromEntries(["free", "k12", "plus", "team"].map((planType) => [planType, {
          error: job.candidates.filter((row) => row.planType === planType && row.stateBucket === "error").length,
          rateLimited: job.candidates.filter((row) => row.planType === planType && row.stateBucket === "rate_limited").length,
        }]));
        const selectedRateLimited = job.candidates.filter((row) => row.stateBucket === "rate_limited").length;
        job.fingerprint = createHash("sha256").update(JSON.stringify({ day: job.settings.day, scope: job.settings.scope, selectionMode: job.settings.selectionMode, accountIds })).digest("hex");
        job.result = {
          tests: job.candidates.map((row) => ({ accountId: row.accountId, planType: row.planType, stateBucket: row.stateBucket,
            classification: "dead", reason: lifecycleRetirementReason(row, job.settings.selectionMode) })),
          summary: { alive: 0, dead: job.candidates.length, unknown: 0,
            selectedRateLimited, excludedRateLimited: rateLimited.length - selectedRateLimited, byPlanType },
          mode: job.settings.selectionMode, valuesPrinted: false,
        };
        job.state = "succeeded";
        this.log(job, "candidates", "done", `退役候选 ${job.candidates.length} 个，其中限流 ${selectedRateLimited} 个；未发起主动探测`);
        await this.persistWorkerJob(job);
        return;
      }
      job.candidates = eligible;
      if (job.candidates.length === 0) throw new Error("没有匹配的 OpenAI OAuth 候选账号");
      const accountIds = job.candidates.map((row) => number(row.accountId));
      job.fingerprint = createHash("sha256").update(JSON.stringify({ day: job.settings.day, planType: job.settings.planType, accountIds })).digest("hex");
      this.log(job, "candidates", "done", `候选 ${accountIds.length} 个，开始原生连接检测`);
      await this.persistWorkerJob(job);
      const tests: unknown[] = [];
      if (!this.runtime) throw new Error("Api2Business Sub2API runtime mutation service 不可用");
      const batchSize = this.config.operations.accountLifecycle.testBatchSize;
      for (let offset = 0; offset < accountIds.length; offset += batchSize) {
        const batch = accountIds.slice(offset, offset + batchSize);
        const batchIndex = Math.floor(offset / batchSize) + 1;
        const batchCount = Math.ceil(accountIds.length / batchSize);
        this.log(job, "test", "start", `检测批次 ${batchIndex}/${batchCount}，账号 ${batch.length} 个`);
        await this.persistWorkerJob(job);
        if (!job.settings.confirm) throw new Error("OAuth 主动检测 worker 只接受已确认作业");
        const batchTests = await Promise.all(batch.map((accountId) => this.runtime!.testAccount(accountId, job.settings.model)));
        if (batchTests.length !== batch.length) {
          throw new Error(`OAuth 检测批次 ${batchIndex}/${batchCount} 结果不完整：候选 ${batch.length}，结果 ${batchTests.length}`);
        }
        tests.push(...batchTests);
        this.log(job, "test", "done", `检测批次 ${batchIndex}/${batchCount} 完成`);
        await this.persistWorkerJob(job);
      }
      const summary = { alive: 0, dead: 0, unknown: 0 };
      for (const item of tests) {
        const classification = item && typeof item === "object" ? String((item as Row).classification ?? "unknown") : "unknown";
        if (classification === "alive" || classification === "dead") summary[classification] += 1;
        else summary.unknown += 1;
      }
      const classified = number(summary.alive) + number(summary.dead) + number(summary.unknown);
      if (tests.length !== accountIds.length || classified !== accountIds.length) {
        throw new Error(`OAuth 检测结果不完整：候选 ${accountIds.length}，结果 ${tests.length}，分类 ${classified}`);
      }
      job.result = { tests, summary, model: job.settings.model, mode: job.settings.confirm ? "confirmed" : "dry-run", valuesPrinted: false };
      job.state = "succeeded";
      this.log(job, "test", "done", `检测完成：存活 ${number(summary.alive)}，死亡 ${number(summary.dead)}，不确定 ${number(summary.unknown)}`);
      await this.persistWorkerJob(job);
    } catch (error) {
      job.state = "failed"; job.error = safeMessage(error instanceof Error ? error.message : String(error));
      this.log(job, "job", "failed", job.error);
      try { await this.persistWorkerJob(job); } catch { /* preserve the original worker failure */ }
    } finally {
      job.completedAt = new Date().toISOString();
      try { await this.persistWorkerJob(job); } catch { /* API may be restarting */ }
    }
  }

  private async finishSettlement(job: LifecycleJob, includeCandidates = true): Promise<void> {
    try {
      const currentEligible = (await this.facts(job.settings.day, job.settings.scope))
        .filter((row) => row.exists === true && row.platform === "openai" && row.type === "oauth"
          && (job.settings.planType === "all" || row.planType === job.settings.planType));
      const current = job.settings.selectionMode === "database-error" || job.settings.selectionMode === "database-dead" || job.settings.selectionMode === "database-all"
        ? currentEligible.filter((row) => lifecycleRetirementReason(row, job.settings.selectionMode) !== null) : currentEligible;
      const currentIds = [...new Set(current.map((row) => number(row.accountId)))].sort((left, right) => left - right);
      const expectedIds = [...new Set(job.candidates.map((row) => number(row.accountId)))].sort((left, right) => left - right);
      const currentSet = new Set(currentIds);
      const expectedSet = new Set(expectedIds);
      const addedIds = currentIds.filter((id) => !expectedSet.has(id));
      const removedIds = expectedIds.filter((id) => !currentSet.has(id));
      if (addedIds.length > 0 || removedIds.length > 0) {
        throw new Error(`候选账号范围已变化，请重新检测；新增 ${addedIds.join(",") || "-"}，移除 ${removedIds.join(",") || "-"}`);
      }
      const gross = current.reduce((sum, row) => sum + number(row.costCny), 0);
      const apiAmountUsd = current.reduce((sum, row) => sum + number(row.apiAmountUsd), 0);
      const accounting = recordLifecycleSettlement(this.config.operations.accountLifecycleLedgerPath, {
        acquisitionDay: job.settings.day, planType: job.settings.planType, accountIds: expectedIds,
        accountCount: expectedIds.length, grossAcquisitionCostCny: Math.round(gross * 100) / 100,
        requestCount: current.reduce((sum, row) => sum + number(row.requestCount), 0),
        tokenCount: current.reduce((sum, row) => sum + number(row.tokenCount), 0),
        apiAmountUsd: Math.round(apiAmountUsd * 1e8) / 1e8,
        grossCnyPerApiUsd: apiAmountUsd > 0 ? Math.round((gross / apiAmountUsd) * 1e6) / 1e6 : null,
        detectionJobId: job.id, detectionFingerprint: job.fingerprint!,
      });
      this.log(job, "accounting", accounting.mutation ? "recorded" : "skipped", `批次结算已记账 ${expectedIds.length} 个账号`);
      await this.persistWorkerJob(job, includeCandidates);
      let deletion: Row | null = null;
      let deletionError: string | null = null;
      try {
        if (!this.runtime) throw new Error("Api2Business Sub2API runtime mutation service 不可用");
        const deleted = await this.runtime.deleteAccounts(
          expectedIds,
          this.config.operations.accountLifecycle.deleteTimeoutMs,
        );
        deletion = { ok: true, operation: "account-batch-delete", ...deleted, valuesPrinted: false };
      } catch (error) {
        deletionError = safeMessage(errorMessage(error));
        this.log(job, "deletion", "verify", `删除命令结果回收失败，转入终态回读：${deletionError}`);
        await this.persistWorkerJob(job, includeCandidates);
      }
      const verified = await this.facts(job.settings.day, job.settings.scope);
      const remaining = verified.filter((row) => expectedIds.includes(number(row.accountId)) && row.exists === true).map((row) => row.accountId);
      job.settlement = { accounting, deletion, deletionError, remainingAccountIds: remaining, valuesPrinted: false };
      await this.persistWorkerJob(job, includeCandidates);
      if (remaining.length > 0) throw new Error(`删除回读仍有 ${remaining.length} 个账号存在${deletionError ? `；命令错误：${deletionError}` : ""}`);
      job.state = "settled"; job.error = null; job.completedAt = new Date().toISOString();
      this.log(job, "verification", "done", `结算与删除完成，回读 ${expectedIds.length}/${expectedIds.length} 已删除`);
      await this.persistWorkerJob(job, includeCandidates);
    } catch (error) {
      job.state = "failed"; job.error = safeMessage(errorMessage(error));
      job.completedAt = new Date().toISOString(); this.log(job, "settlement", "failed", job.error);
      try { await this.persistWorkerJob(job, includeCandidates); } catch { /* preserve the original worker failure */ }
    }
  }
}

export const accountLifecycleCandidateQuery = candidateSql;
