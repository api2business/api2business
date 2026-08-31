import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AdminHttpClient } from "./admin-http-client";
import { recoveryConfigFromInspection, verifyRecoveredOAuthConfig } from "./account-inspection";
import type { AccountRecoveryConfig } from "./account-recovery-config";
import type { AppConfig, HttpCliTarget } from "./config";
import { PublicRecoveryClient } from "./public-recovery-client";

type Json = Record<string, unknown>;
export type RecoveryStage = "health" | "reclaim" | "status" | "download" | "import-submit" | "import-status" | "verify";
type JobState = "queued" | "running" | "waiting" | "failed" | "succeeded";

export interface PublicRecoveryJob {
  version: 1;
  id: string;
  accountId: number;
  baseUrl: string;
  outputPath: string;
  unitCostCny: number;
  planType: "k12" | "plus" | "team" | "free";
  state: JobState;
  stage: RecoveryStage | "created" | "done";
  nextStage: RecoveryStage | null;
  createdAt: string;
  updatedAt: string;
  needReclaim: boolean | null;
  importJobId: string | null;
  revivedAccountIds: number[];
  recoveryConfig: AccountRecoveryConfig;
  logs: Array<{ timestamp: string; stage: string; state: string; message: string }>;
  result: Json | null;
  error: string | null;
}

function object(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function safeMessage(value: unknown): string {
  return String(value ?? "unknown error")
    .replace(/(?:team-[A-Za-z0-9-]+|sk-[A-Za-z0-9]+|Bearer\s+\S+)/gu, "[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[redacted]")
    .slice(0, 500);
}

function positiveAccountId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("--account-id must be a positive integer");
  return id;
}

function stageNeedsCode(stage: RecoveryStage | null): boolean {
  return stage === "health" || stage === "reclaim" || stage === "status" || stage === "download";
}

function createdAccountIds(value: unknown): number[] {
  const ids: number[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    const row = object(item);
    if (!row) return;
    if (Array.isArray(row.createdIds)) {
      for (const value of row.createdIds) {
        const id = Number(value);
        if (Number.isSafeInteger(id) && id > 0) ids.push(id);
      }
    }
    Object.values(row).forEach(visit);
  };
  visit(value);
  return [...new Set(ids)].sort((a, b) => a - b);
}

function importJobState(value: Json): string {
  const job = object(value.job);
  return String(job?.state ?? value.state ?? "unknown").toLowerCase();
}

function safeStageResult(stage: RecoveryStage, value: Json): Json {
  if (stage === "import-status") {
    const imported = object(value.job);
    return {
      ok: value.ok,
      state: imported?.state ?? value.state,
      importJobId: imported?.id ?? value.jobId,
      valuesPrinted: false,
    };
  }
  if (stage === "verify") return { ok: value.ok, accountIds: value.accountIds, aligned: value.aligned, selected: value.selected, valuesPrinted: false };
  return value;
}

export class PublicRecoveryJobManager {
  private readonly directory: string;
  private readonly admin: AdminHttpClient;

  constructor(private readonly config: AppConfig, target: HttpCliTarget) {
    this.directory = join(config.rootDirectory, ".state", "public-recovery");
    this.admin = new AdminHttpClient(config, target);
  }

  private publicClient(baseUrl: string): PublicRecoveryClient {
    return new PublicRecoveryClient(baseUrl, this.config.bugTeam.requestTimeoutMs);
  }

  private path(id: string): string { return join(this.directory, `${id}.json`); }

  private async save(job: PublicRecoveryJob): Promise<void> {
    job.updatedAt = new Date().toISOString();
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.path(job.id)}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(job, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.path(job.id));
  }

  async get(id: string): Promise<PublicRecoveryJob> {
    const job = JSON.parse(await readFile(this.path(id), "utf8")) as PublicRecoveryJob;
    if (job.version !== 1 || job.id !== id || !Array.isArray(job.logs) || !Array.isArray(job.revivedAccountIds) || !job.recoveryConfig) {
      throw new Error("public recovery job file lacks the required configuration snapshot; create a new job");
    }
    return job;
  }

  private log(job: PublicRecoveryJob, stage: string, state: string, message: string): void {
    job.logs.push({ timestamp: new Date().toISOString(), stage, state, message: safeMessage(message) });
  }

  private project(job: PublicRecoveryJob): Json {
    return {
      ok: job.state !== "failed",
      action: "public-recovery-job",
      jobId: job.id,
      accountId: job.accountId,
      state: job.state,
      stage: job.stage,
      nextStage: job.nextStage,
      needReclaim: job.needReclaim,
      importJobId: job.importJobId,
      revivedAccountIds: job.revivedAccountIds,
      recoveryConfigCaptured: true,
      output: job.outputPath,
      error: job.error,
      logs: job.logs,
      result: job.result,
      valuesPrinted: false,
    };
  }

  async create(input: {
    accountId: number;
    baseUrl: string;
    outputPath: string;
    unitCostCny: number;
    planType: "k12" | "plus" | "team" | "free";
  }): Promise<PublicRecoveryJob> {
    const accountId = positiveAccountId(input.accountId);
    if (input.unitCostCny !== 0.01) throw new Error("public recovery import cost is fixed at ¥0.01");
    new PublicRecoveryClient(input.baseUrl, this.config.bugTeam.requestTimeoutMs);
    const recoveryConfig = await this.captureRecoveryConfig(accountId);
    const id = randomUUID();
    const now = new Date().toISOString();
    const job: PublicRecoveryJob = {
      version: 1, id, accountId, baseUrl: input.baseUrl, outputPath: resolve(input.outputPath),
      unitCostCny: input.unitCostCny, planType: input.planType, state: "queued", stage: "created",
      nextStage: "health", createdAt: now, updatedAt: now, needReclaim: null, importJobId: null,
      revivedAccountIds: [], recoveryConfig,
      logs: [], result: null, error: null,
    };
    this.log(job, "job", "queued", `已创建复活作业并冻结原账号运行配置，目标账号 ${accountId}`);
    await this.save(job);
    return job;
  }

  async captureRecoveryConfig(accountId: number): Promise<AccountRecoveryConfig> {
    const result = await this.admin.inspectAccounts([positiveAccountId(accountId)]);
    return recoveryConfigFromInspection(result, accountId);
  }

  async assertOAuthAccount(accountId: number): Promise<void> {
    await this.captureRecoveryConfig(accountId);
  }

  async importDownloaded(input: {
    accountId: number;
    filePath: string;
    planType: "k12" | "plus" | "team" | "free";
  }): Promise<Json> {
    const recoveryConfig = await this.captureRecoveryConfig(input.accountId);
    const content = await readFile(resolve(input.filePath), "utf8");
    const response = await this.admin.accountImport({
      content,
      inputFormat: "json",
      priority: recoveryConfig.priority,
      capacity: recoveryConfig.capacity,
      rateMultiplier: recoveryConfig.loadFactor ?? this.config.operations.accountImportDefaults.rateMultiplier,
      groupIds: recoveryConfig.groupIds,
      sourceProxyId: recoveryConfig.proxyId,
      perAccountProxy: false,
      unitCostCny: 0.01,
      planType: input.planType,
      platform: "openai",
      cutoffTrigger: "public-recovery",
      allowDuplicate: true,
      recoveryConfig,
      confirm: true,
    });
    const imported = object(response.job);
    const importJobId = typeof imported?.id === "string" ? imported.id : typeof response.jobId === "string" ? response.jobId : null;
    if (!importJobId) throw new Error("账号导入已受理但未返回可查询的 job ID");
    return {
      ok: true,
      action: "public-recovery-import",
      accountId: input.accountId,
      importJobId,
      state: imported?.state ?? response.state,
      unitCostCny: 0.01,
      valuesPrinted: false,
    };
  }

  async launch(job: PublicRecoveryJob, configPath: string, cardCode: string, requestedStage?: RecoveryStage): Promise<Json> {
    if (job.state === "succeeded") throw new Error("public recovery job already succeeded");
    const next = requestedStage ?? job.nextStage;
    if (!next) throw new Error("public recovery job has no next stage");
    if (stageNeedsCode(next) && !cardCode.trim()) throw new Error(`stage ${next} requires --card-code-stdin`);
    if (requestedStage) {
      job.nextStage = requestedStage;
      await this.save(job);
    }
    const script = resolve(process.argv[1] ?? "skills/api2business/scripts/api2business-cli.ts");
    const command = [process.execPath, script, "--config", configPath, "bugteam", "public-recovery", "worker", "--id", job.id, "--stage", next];
    if (stageNeedsCode(next)) command.push("--card-code-stdin");
    const child = Bun.spawn(command, {
      cwd: this.config.rootDirectory,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    child.stdin?.write(cardCode);
    child.stdin?.end();
    child.unref();
    return { ok: true, action: "public-recovery-job", jobId: job.id, accountId: job.accountId, state: "running", nextStage: next, valuesPrinted: false };
  }

  async run(id: string, cardCode: string, requestedStage?: RecoveryStage): Promise<Json> {
    const job = await this.get(id);
    const stage = requestedStage ?? job.nextStage;
    if (!stage) throw new Error("public recovery job has no stage to run");
    if (stageNeedsCode(stage) && !cardCode.trim()) throw new Error(`stage ${stage} requires card code from stdin`);
    job.state = "running"; job.stage = stage; job.error = null;
    this.log(job, stage, "start", `开始执行阶段 ${stage}`); await this.save(job);
    try {
      let result: Json;
      if (stage === "health") {
        result = await this.publicClient(job.baseUrl).health(cardCode);
        job.needReclaim = Number(result.needReclaim) > 0;
        job.nextStage = job.needReclaim ? "reclaim" : "status";
      } else if (stage === "reclaim") {
        result = await this.publicClient(job.baseUrl).reclaim(cardCode, "401");
        job.nextStage = "status";
      } else if (stage === "status") {
        result = await this.publicClient(job.baseUrl).status(cardCode);
        job.nextStage = "download";
      } else if (stage === "download") {
        result = await this.publicClient(job.baseUrl).download(cardCode, job.outputPath);
        job.nextStage = "import-submit";
      } else if (stage === "import-submit") {
        const content = await readFile(job.outputPath, "utf8");
        const response = await this.admin.accountImport({
          content, inputFormat: "json", priority: job.recoveryConfig.priority, capacity: job.recoveryConfig.capacity,
          rateMultiplier: job.recoveryConfig.loadFactor ?? this.config.operations.accountImportDefaults.rateMultiplier,
          groupIds: job.recoveryConfig.groupIds, sourceProxyId: job.recoveryConfig.proxyId, perAccountProxy: false,
          unitCostCny: 0.01, planType: job.planType, platform: "openai", cutoffTrigger: "public-recovery",
          allowDuplicate: true, recoveryConfig: job.recoveryConfig, confirm: true,
        });
        const imported = object(response.job);
        const importJobId = typeof imported?.id === "string" ? imported.id : typeof response.jobId === "string" ? response.jobId : null;
        if (!importJobId) throw new Error("账号导入已受理但未返回可查询的 job ID");
        job.importJobId = importJobId; job.nextStage = "import-status";
        result = { ok: true, importJobId, state: imported?.state ?? response.state, valuesPrinted: false };
      } else if (stage === "import-status") {
        if (!job.importJobId) throw new Error("缺少账号导入 job ID");
        result = await this.admin.accountImportStatus(job.importJobId);
        const state = importJobState(result);
        if (!["succeeded", "completed", "success"].includes(state)) {
          if (["failed", "error", "cancelled"].includes(state)) throw new Error(`账号导入作业失败：${state}`);
          job.state = "waiting"; job.nextStage = "import-status";
          this.log(job, stage, "waiting", `账号导入仍未终态：${state}；可用 continue 继续查询`);
          job.result = { ...(job.result ?? {}), [stage]: result };
          await this.save(job);
          return this.project(job);
        }
        const createdIds = createdAccountIds(result);
        if (createdIds.length === 0) throw new Error("账号导入作业未返回新建 OAuth 副本 ID");
        job.revivedAccountIds = createdIds;
        job.nextStage = "verify";
      } else {
        if (job.revivedAccountIds.length === 0) throw new Error("缺少新复活账号 ID，无法验证配置继承");
        const inspection = await this.admin.inspectAccounts(job.revivedAccountIds);
        const verification = verifyRecoveredOAuthConfig(inspection, job.revivedAccountIds, job.recoveryConfig);
        if (verification.ok !== true) throw new Error("新复活账号未继承原账号运行配置");
        result = { ...verification, accountIds: job.revivedAccountIds, valuesPrinted: false };
        job.nextStage = null; job.stage = "done"; job.state = "succeeded";
      }
      job.result = { ...(job.result ?? {}), [stage]: safeStageResult(stage, result) };
      if (job.state !== "succeeded") job.state = "waiting";
      this.log(job, stage, "done", `阶段 ${stage} 完成`);
      await this.save(job);
      return this.project(job);
    } catch (error) {
      job.state = "failed"; job.error = safeMessage(error instanceof Error ? error.message : error); job.nextStage = stage;
      this.log(job, stage, "failed", job.error); await this.save(job);
      return this.project(job);
    }
  }

  projectJob(job: PublicRecoveryJob): Json { return this.project(job); }
  static requiresCode(stage: RecoveryStage | null): boolean { return stageNeedsCode(stage); }
}

export function publicRecoveryStateDirectory(config: AppConfig): string {
  return join(config.rootDirectory, ".state", "public-recovery");
}
