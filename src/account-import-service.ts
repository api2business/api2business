import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, OAuthPlanType } from "./config";
import { accountImportPreflight, type AccountImportPreflightPlan } from "./account-import-preflight";
import { recordAccountImportCosts, recordAccountImportPlanTypeCorrections } from "./account-import-cost-ledger";
import { inspectAccounts, verifyImportedAccounts } from "./account-inspection";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import { normalizeAccountImportInput } from "./account-import-input";
import type { TemporalGateway } from "./temporal-client";
import type { Sub2ApiRuntimeService } from "./sub2api-runtime-service";

export interface AccountImportRequest {
  content: string;
  inputFormat?: "json" | "zip";
  priority: number;
  capacity: number;
  groupIds: number[];
  sourceProxyId: number;
  perAccountProxy?: boolean;
  unitCostCny: number;
  planType: OAuthPlanType;
  platform?: "openai" | "grok";
  confirm: boolean;
}

export interface ImportLog { timestamp: string; stage: string; state: string; message: string }
export interface ImportJob {
  id: string; state: "queued" | "running" | "succeeded" | "failed"; createdAt: string;
  completedAt: string | null; fingerprint: string; accountCount: number; settings: Omit<AccountImportRequest, "content">;
  inputArchive: { stored: true; fileName: string };
  source: { format: "json" | "zip"; jsonFileCount: number; duplicateAccountCount: number; platform: "openai" | "grok" };
  logs: ImportLog[]; result: Record<string, unknown> | null; accounting: Record<string, unknown> | null; error: string | null;
  workflow?: { workflowId: string; runId: string; state: "submitted" };
}

export interface ImportJobPatch {
  state?: ImportJob["state"];
  completedAt?: string | null;
  logs?: ImportLog[];
  result?: Record<string, unknown> | null;
  accounting?: Record<string, unknown> | null;
  error?: string | null;
}

export interface ImportJobControl {
  get(id: string): Promise<ImportJob | null>;
  patch(id: string, patch: ImportJobPatch): Promise<void>;
}

function validate(input: AccountImportRequest): void {
  if (input.inputFormat !== undefined && input.inputFormat !== "json" && input.inputFormat !== "zip") {
    throw new Error("导入格式只允许 json 或 zip");
  }
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 1000) throw new Error("优先级必须为 1 至 1000");
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 100000) throw new Error("容量必须为正整数");
  if (!Array.isArray(input.groupIds) || input.groupIds.length === 0 || input.groupIds.some((id) => !Number.isInteger(id) || id < 1)) throw new Error("至少选择一个有效分组");
  if (!Number.isInteger(input.sourceProxyId) || input.sourceProxyId < 3) throw new Error("代理池基准 ID 必须是不小于 3 的正整数");
  if (input.perAccountProxy !== undefined && typeof input.perAccountProxy !== "boolean") throw new Error("逐账号代理选项必须是布尔值");
  if (!Number.isFinite(input.unitCostCny) || input.unitCostCny <= 0
    || Math.abs(Math.round(input.unitCostCny * 100) - input.unitCostCny * 100) > 1e-8) {
    throw new Error("账号单价必须为正数人民币，最多两位小数");
  }
  if (input.planType !== "k12" && input.planType !== "plus" && input.planType !== "team" && input.planType !== "free") {
    throw new Error("账号类型只允许 k12、plus、team 或 free");
  }
  if (input.platform !== "openai" && input.platform !== "grok") throw new Error("账号平台识别结果无效");
  if (input.platform === "grok" && input.planType !== "free") throw new Error("Grok 导入当前只支持 free 类型");
}

function safeMessage(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/rt\.\d\.[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/user-[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/gu, "[REDACTED]")
    .slice(0, 500);
}

export function importFailure(output: Record<string, unknown>): string {
  const resultCandidates = [output.result];
  const projection = output.projection && typeof output.projection === "object" && !Array.isArray(output.projection)
    ? output.projection as Record<string, unknown> : null;
  if (projection) resultCandidates.push(projection.result);
  const candidates: unknown[] = [output.error];
  const data = output.data && typeof output.data === "object" && !Array.isArray(output.data) ? output.data as Record<string, unknown> : null;
  if (data) {
    candidates.push(data.error, data.runtime && typeof data.runtime === "object" ? (data.runtime as Record<string, unknown>).error : null);
    resultCandidates.push(data.result);
  }
  for (const candidate of resultCandidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const result = candidate as Record<string, unknown>;
    const failures = Array.isArray(result.failures) ? result.failures : [];
    const reasons = failures.flatMap((failure) => {
      if (!failure || typeof failure !== "object" || Array.isArray(failure)) return [];
      const item = failure as Record<string, unknown>;
      if (typeof item.reason !== "string" || !item.reason.trim()) return [];
      const index = Number.isInteger(item.index) ? `#${item.index} ` : "";
      return [`${index}${item.reason.trim()}`];
    });
    if (reasons.length > 0) return safeMessage(`账号导入失败：${reasons.join("；")}`);
    if (typeof result.failed === "number" && result.failed > 0) return `账号导入报告 ${result.failed} 个失败项，但未返回原因`;
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return safeMessage(candidate);
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const error = candidate as Record<string, unknown>;
      const message = typeof error.message === "string" ? error.message.trim() : "";
      const code = typeof error.code === "string" ? error.code.trim() : "";
      if (message) return safeMessage(code ? `${code}: ${message}` : message);
    }
  }
  return "runtime 导入失败，但未返回可识别的错误原因";
}

export function archiveAccountImportContent(directory: string, jobId: string, content: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const fileName = `${jobId}.json`;
  const path = join(directory, fileName);
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return fileName;
}

export class AccountImportService {
  private jobs = new Map<string, ImportJob>();
  constructor(
    private config: AppConfig,
    private reads: Sub2ApiReadClient,
    private temporal: TemporalGateway | null = null,
    private workerJobs: ImportJobControl | null = null,
    private runtime: Sub2ApiRuntimeService | null = null,
  ) {}

  options() {
    return { ok: true, currency: "CNY", inputFormats: ["json", "zip"], planTypes: [{ id: "k12", name: "K12" }, { id: "plus", name: "Plus" }, { id: "team", name: "Team" }, { id: "free", name: "Free" }], initialExpectedApiUsdPerAccount: { ...this.config.operations.oauthEconomics.idealApiUsdPerAccount }, defaults: { ...this.config.operations.accountImportDefaults, unitCostCny: null }, groups: [
      { id: 2, name: "混池（unidesk-codex-pool）" }, { id: 3, name: "自用" }, { id: 6, name: "Grok" },
    ] };
  }

  preview(input: Pick<AccountImportRequest, "content" | "inputFormat">) {
    const parsed = normalizeAccountImportInput(input.content, input.inputFormat);
    return { ok: true, ...parsed, valuesPrinted: false };
  }

  async submit(input: AccountImportRequest): Promise<ImportJob> {
    const parsed = normalizeAccountImportInput(input.content, input.inputFormat);
    const selectedPlatform = input.platform ?? parsed.platform;
    const normalizedInput: AccountImportRequest = {
      ...input,
      platform: selectedPlatform,
      planType: selectedPlatform === "grok" ? "free" : input.planType,
      groupIds: selectedPlatform === "grok" && input.groupIds.length === 2
        && input.groupIds.includes(2) && input.groupIds.includes(3) ? [6] : input.groupIds,
      perAccountProxy: input.perAccountProxy ?? this.config.operations.accountImportDefaults.perAccountProxy,
    };
    validate(normalizedInput);
    const id = randomUUID();
    const selectedContent = overrideAccountImportPlatform(parsed.content, selectedPlatform);
    const archiveFileName = archiveAccountImportContent(this.config.operations.accountImportArchiveDirectory, id, selectedContent);
    const job: ImportJob = { id, state: "queued", createdAt: new Date().toISOString(), completedAt: null,
      accountCount: parsed.accountCount, fingerprint: parsed.fingerprint, source: { ...parsed.source, platform: selectedPlatform },
      settings: { priority: normalizedInput.priority, capacity: normalizedInput.capacity, groupIds: [...new Set(normalizedInput.groupIds)], sourceProxyId: normalizedInput.sourceProxyId, perAccountProxy: normalizedInput.perAccountProxy, unitCostCny: normalizedInput.unitCostCny, planType: normalizedInput.planType, platform: normalizedInput.platform, confirm: normalizedInput.confirm },
      inputArchive: { stored: true, fileName: archiveFileName },
      logs: [], result: null, accounting: null, error: null };
    this.jobs.set(id, job);
    while (this.jobs.size > 20) this.jobs.delete(this.jobs.keys().next().value!);
    if (!this.temporal) {
      job.state = "failed";
      job.error = "Temporal worker 当前不可用";
      this.log(job, "job", "failed", job.error);
      job.completedAt = new Date().toISOString();
      throw new Error(job.error);
    }
    try {
      job.workflow = await this.temporal.submit({ kind: "account.import", jobId: id });
    } catch (error) {
      job.state = "failed";
      job.error = safeMessage(error instanceof Error ? error.message : String(error));
      this.log(job, "job", "failed", job.error);
      job.completedAt = new Date().toISOString();
      throw error;
    }
    return this.project(job);
  }

  get(id: string): ImportJob | null { const job = this.jobs.get(id); return job ? this.project(job) : null; }
  workerGet(id: string): ImportJob | null { return this.get(id); }
  applyWorkerPatch(id: string, patch: ImportJobPatch): Record<string, unknown> {
    const job = this.jobs.get(id);
    if (!job) throw new Error("导入作业不存在");
    if (patch.state !== undefined) job.state = patch.state;
    if (patch.completedAt !== undefined) job.completedAt = patch.completedAt;
    if (patch.logs !== undefined) job.logs = structuredClone(patch.logs);
    if (patch.result !== undefined) job.result = patch.result ? structuredClone(patch.result) : null;
    if (patch.accounting !== undefined) job.accounting = patch.accounting ? structuredClone(patch.accounting) : null;
    if (patch.error !== undefined) job.error = patch.error;
    return { ok: true, job: this.project(job), valuesPrinted: false };
  }

  async runWorker(id: string): Promise<ImportJob> {
    if (!this.workerJobs) throw new Error("账号导入 worker job 控制面不可用");
    const job = await this.workerJobs.get(id);
    if (!job) throw new Error("导入作业不存在");
    if (job.state === "succeeded" || job.state === "failed") return job;
    const path = join(this.config.operations.accountImportArchiveDirectory, job.inputArchive.fileName);
    const content = readFileSync(path, "utf8");
    await this.run(job, content);
    return job;
  }

  inspect(accountIds: number[]): Promise<Record<string, unknown>> { return inspectAccounts(accountIds, this.reads); }
  private project(job: ImportJob): ImportJob { return structuredClone(job); }
  private log(job: ImportJob, stage: string, state: string, message: string) {
    job.logs.push({ timestamp: new Date().toISOString(), stage, state, message: safeMessage(message) });
  }

  private async persistWorkerJob(job: ImportJob): Promise<void> {
    if (!this.workerJobs) return;
    await this.workerJobs.patch(job.id, {
      state: job.state,
      completedAt: job.completedAt,
      logs: job.logs,
      result: job.result,
      accounting: job.accounting,
      error: job.error,
    });
  }

  private async run(job: ImportJob, content: string): Promise<void> {
    try {
      if (!this.runtime) throw new Error("Api2Business Sub2API runtime mutation service 不可用");
      job.state = "running"; this.log(job, "job", "start", `开始处理 ${job.accountCount} 个账号`); await this.persistWorkerJob(job);
      let plan = await accountImportPreflight(content, {
        ...job.settings,
        platform: job.settings.platform ?? job.source.platform,
      }, this.reads);
      for (const skipped of plan.skipped) {
        this.log(job, "account", "skipped", `stage=account state=skipped index=${skipped.index}/${job.accountCount} account-id=${skipped.accountId}`);
      }
      const correctedAccountIds = plan.planTypeCorrections.map((item) => item.accountId);
      if (correctedAccountIds.length > 0) {
        if (!job.settings.confirm) throw new Error("账号导入 worker 只接受已确认作业");
        this.log(job, "plan-type-correction", "start", `stage=plan-type-correction state=start accounts=${correctedAccountIds.length} plan-type=${job.settings.planType}`);
        await this.persistWorkerJob(job);
        await this.runtime.correctAccountPlanTypes(correctedAccountIds, job.settings.planType);
        const reconciled = await accountImportPreflight(content, {
          ...job.settings,
          platform: job.settings.platform ?? job.source.platform,
        }, this.reads);
        if (reconciled.planTypeCorrections.length > 0) {
          throw new Error(`账号类型更正后仍有 ${reconciled.planTypeCorrections.length}/${correctedAccountIds.length} 个账号未对齐`);
        }
        plan = reconciled;
        this.log(job, "plan-type-correction", "done", `stage=plan-type-correction state=done accounts=${correctedAccountIds.length} plan-type=${job.settings.planType}`);
        await this.persistWorkerJob(job);
      }
      this.log(job, "proxy", "planned", job.settings.perAccountProxy === true
        ? `代理池候选 ${plan.proxyCandidateIds.length} 个，将为每个新建账号独立随机分配`
        : `代理池候选 ${plan.proxyCandidateIds.length} 个，整批共用 Proxy #${plan.initialProxyId}（原生批量导入）`);
      await this.persistWorkerJob(job);
      if (plan.sourceIndexes.length === 0) {
        job.result = completedWithoutWrites(job, plan, correctedAccountIds);
        const ledgerAccountIds = plan.skipped.map((item) => item.accountId);
        if (ledgerAccountIds.length > 0) {
          const planTypeCorrections = recordAccountImportPlanTypeCorrections({
            path: this.config.operations.accountImportLedgerPath,
            accountIds: ledgerAccountIds,
            planType: job.settings.planType,
          });
          job.accounting = { recordedCount: 0, totalCostCny: 0, planTypeCorrections };
          job.result.accounting = job.accounting;
          this.log(job, "accounting", "recorded", `人民币采购成本已记账 0 个账号，共 ¥0.00；类型更正 ${planTypeCorrections.correctedCount} 个`);
        }
        job.state = "succeeded";
        this.log(job, "job", "done", correctedAccountIds.length > 0 ? "已有账号类型已更正，本轮未新增账号" : "全部账号已导入并对齐，本轮未写入");
        await this.persistWorkerJob(job);
        return;
      }
      if (!job.settings.confirm) throw new Error("账号导入 worker 只接受已确认作业");
      this.log(job, "batch-import", "start", `stage=batch-import state=start accounts=${plan.sourceIndexes.length} initial-proxy=${plan.initialProxyId}`);
      await this.persistWorkerJob(job);
      let output: Record<string, unknown>;
      try {
        output = await this.runtime.importAccounts({
          operationKey: job.id,
          content: plan.content,
          importTimeoutMs: this.config.operations.accountImportDefaults.importTimeoutMs,
          priority: job.settings.priority,
          capacity: job.settings.capacity,
          groupIds: job.settings.groupIds,
          proxyId: plan.initialProxyId,
          proxyCandidateIds: plan.proxyCandidateIds,
          perAccountProxy: job.settings.perAccountProxy === true,
        });
      } catch (error) {
        if (!isTimeoutError(error)) throw error;
        this.log(job, "reconciliation", "start", "导入请求超时，正在通过排队数据库核对账号终态");
        await this.persistWorkerJob(job);
        const reconciled = await accountImportPreflight(content, {
          ...job.settings,
          platform: job.settings.platform ?? job.source.platform,
        }, this.reads);
        if (reconciled.sourceIndexes.length > 0) {
          throw new Error(`Sub2API 批量导入在 ${this.config.operations.accountImportDefaults.importTimeoutMs}ms 后超时；终态对账仍缺少 ${reconciled.sourceIndexes.length}/${job.accountCount} 个账号`);
        }
        output = recoveredImportOutput(job, plan, reconciled);
        this.log(job, "reconciliation", "done", "导入响应超时，但排队数据库终态已全部对齐");
      }
      this.log(job, "batch-import", output.ok === false ? "failed" : "done", `stage=batch-import state=${output.ok === false ? "failed" : "done"} accounts=${plan.sourceIndexes.length}`);
      mergePreflightResult(output, job, plan);
      job.result = output;
      const result = output.result && typeof output.result === "object" && !Array.isArray(output.result)
        ? output.result as Record<string, unknown> : null;
      const createdIds = Array.isArray(result?.createdIds)
        ? result.createdIds.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0) : [];
      const updatedIds = Array.isArray(result?.updatedIds)
        ? result.updatedIds.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0) : [];
      const skippedIds = Array.isArray(result?.skippedIds)
        ? result.skippedIds.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0) : [];
      const verifiedIds = [...new Set([...createdIds, ...updatedIds, ...skippedIds])];
      if (job.settings.confirm && verifiedIds.length > 0) {
        output.verification = await verifyImportedAccounts(verifiedIds, job.settings, plan.proxyCandidateIds, this.reads, {
          sharedProxyId: job.settings.perAccountProxy === true ? undefined : plan.initialProxyId,
          strictProxyAccountIds: [...createdIds, ...updatedIds],
        });
        const verification = output.verification as Record<string, unknown>;
        this.log(job, "verification", verification.ok === true ? "done" : "failed",
          `账号终态校验 ${verification.aligned}/${verification.selected} 对齐`);
        await this.persistWorkerJob(job);
      }
      if (job.settings.confirm && (createdIds.length > 0 || updatedIds.length > 0)) {
        const acquisition = recordAccountImportCosts({
          path: this.config.operations.accountImportLedgerPath,
          fingerprint: job.fingerprint,
          accountIds: createdIds,
          unitCostCny: job.settings.unitCostCny,
          planType: job.settings.planType,
          occurredOn: new Date().toLocaleDateString("sv-SE", { timeZone: this.config.monitor.timezone }),
        });
        const planTypeCorrections = recordAccountImportPlanTypeCorrections({
          path: this.config.operations.accountImportLedgerPath,
          accountIds: [...plan.skipped.map((item) => item.accountId), ...updatedIds],
          planType: job.settings.planType,
        });
        job.accounting = { ...acquisition, planTypeCorrections };
        const accounting = job.accounting;
        this.log(job, "accounting", "recorded", `人民币采购成本已记账 ${accounting.recordedCount} 个账号，共 ¥${Number(accounting.totalCostCny).toFixed(2)}；类型更正 ${planTypeCorrections.correctedCount} 个`);
        output.accounting = accounting;
        await this.persistWorkerJob(job);
      }
      const verification = output.verification as Record<string, unknown> | undefined;
      if (output.ok === false || verification?.ok === false) {
        job.state = "failed";
        job.error = verification?.ok === false ? "导入后的账号配置未全部对齐，请查看 verification.accounts" : importFailure(output);
        this.log(job, "job", "failed", job.error);
        await this.persistWorkerJob(job);
        return;
      }
      job.state = "succeeded"; this.log(job, "job", "done", "导入作业完成"); await this.persistWorkerJob(job);
    } catch (error) {
      job.state = "failed"; job.error = safeMessage(error instanceof Error ? error.message : String(error));
      this.log(job, "job", "failed", job.error);
      try { await this.persistWorkerJob(job); } catch { /* preserve the original worker failure */ }
    } finally {
      job.completedAt = new Date().toISOString();
      try { await this.persistWorkerJob(job); } catch { /* API may be restarting; Temporal retains the bounded result */ }
    }
  }

  private async captureProgress(job: ImportJob, stream: ReadableStream<Uint8Array>, plan: AccountImportPreflightPlan): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    const consume = async (line: string): Promise<void> => {
      let text = line.trim();
      if (!text) return;
      const match = /stage=account state=([^ ]+) index=(\d+)\/(\d+)/u.exec(text);
      if (match) {
        const filteredIndex = Number(match[2]);
        const sourceIndex = plan.sourceIndexes[filteredIndex - 1];
        if (sourceIndex !== undefined) text = text.replace(`index=${match[2]}/${match[3]}`, `index=${sourceIndex}/${job.accountCount}`);
      }
      const stage = /stage=([^ ]+)/u.exec(text)?.[1] ?? "runtime";
      const state = /state=([^ ]+)/u.exec(text)?.[1] ?? "progress";
      this.log(job, stage, state, text.replace(/^.*?PROGRESS\s+/u, ""));
      await this.persistWorkerJob(job);
    };
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) await consume(line);
    }
    pending += decoder.decode();
    await consume(pending);
  }
}

function completedWithoutWrites(job: ImportJob, plan: AccountImportPreflightPlan, correctedAccountIds: number[] = []): Record<string, unknown> {
  return {
    ok: true,
    action: "api2business-sub2api-runtime-import",
    mode: "confirmed",
    mutation: correctedAccountIds.length > 0,
    file: { fingerprint: job.fingerprint, accountCount: job.accountCount, valuesPrinted: false },
    settings: {
      ...job.settings,
      assignmentMode: job.settings.perAccountProxy === true ? "per-account-random" : "batch-shared",
      sharedProxyId: job.settings.perAccountProxy === true ? null : plan.initialProxyId,
      proxyCandidateCount: plan.proxyCandidateIds.length,
    },
    result: {
      createdIds: [], updatedIds: [], skippedIds: plan.skipped.map((item) => item.accountId),
      planTypeCorrectedIds: correctedAccountIds, planTypeCorrected: correctedAccountIds.length,
      skipped: plan.skipped.length, failed: 0, failures: [], isolated: 0,
    },
    valuesPrinted: false,
  };
}

export function isTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timed?\s*out|timeout/iu.test(message);
}

export function recoveredImportOutput(
  job: ImportJob,
  plan: AccountImportPreflightPlan,
  reconciled: AccountImportPreflightPlan,
): Record<string, unknown> {
  const initiallySkipped = new Set(plan.skipped.map((item) => item.accountId));
  const existingByIndex = new Map(plan.pendingExisting.map((item) => [item.index, item.accountId]));
  const updatedIds: number[] = [];
  const createdIds: number[] = [];
  for (const item of reconciled.skipped) {
    if (initiallySkipped.has(item.accountId)) continue;
    if (existingByIndex.get(item.index) === item.accountId) updatedIds.push(item.accountId);
    else createdIds.push(item.accountId);
  }
  return {
    ok: true,
    action: "api2business-sub2api-runtime-import",
    mode: "confirmed",
    mutation: createdIds.length + updatedIds.length > 0,
    recoveredAfterTimeout: true,
    file: { fingerprint: job.fingerprint, accountCount: job.accountCount, valuesPrinted: false },
    result: {
      createdIds,
      updatedIds,
      skippedIds: plan.skipped.map((item) => item.accountId),
      skipped: plan.skipped.length,
      failed: 0,
      failures: [],
      proxyAssignments: [],
      sharedProxyId: job.settings.perAccountProxy === true ? null : plan.initialProxyId,
    },
    valuesPrinted: false,
  };
}

function mergePreflightResult(output: Record<string, unknown>, job: ImportJob, plan: AccountImportPreflightPlan): void {
  const result = output.result && typeof output.result === "object" && !Array.isArray(output.result) ? output.result as Record<string, unknown> : null;
  if (!result) return;
  const existingSkipped = Array.isArray(result.skippedIds) ? result.skippedIds.filter((item): item is number => Number.isSafeInteger(item)) : [];
  result.skippedIds = [...new Set([...existingSkipped, ...plan.skipped.map((item) => item.accountId)])];
  result.skipped = (result.skippedIds as number[]).length;
  if (Array.isArray(result.failures)) {
    result.failures = result.failures.map((failure) => {
      if (!failure || typeof failure !== "object" || Array.isArray(failure)) return failure;
      const item = failure as Record<string, unknown>;
      const index = typeof item.index === "number" ? plan.sourceIndexes[item.index - 1] : undefined;
      return index === undefined ? item : { ...item, index };
    });
  }
  const file = output.file && typeof output.file === "object" && !Array.isArray(output.file) ? output.file as Record<string, unknown> : null;
  if (file) accountImportFileProjection(file, job);
}

function accountImportFileProjection(file: Record<string, unknown>, job: ImportJob): void {
  file.accountCount = job.accountCount;
  file.fingerprint = job.fingerprint;
}

function overrideAccountImportPlatform(content: string, platform: "openai" | "grok"): string {
  const payload = JSON.parse(content) as Record<string, unknown>;
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  return JSON.stringify({
    ...payload,
    accounts: accounts.map((value) => {
      const account = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      return { ...account, platform };
    }),
  });
}
