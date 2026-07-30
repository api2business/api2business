import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config";
import { accountImportPreflight, type AccountImportPreflightPlan } from "./account-import-preflight";
import { recordAccountImportCosts } from "./account-import-cost-ledger";
import { inspectAccounts, verifyImportedAccounts } from "./account-inspection";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

export interface AccountImportRequest {
  content: string;
  priority: number;
  capacity: number;
  groupIds: number[];
  sourceProxyId: number;
  unitCostCny: number;
  confirm: boolean;
}

interface ImportLog { timestamp: string; stage: string; state: string; message: string }
interface ImportJob {
  id: string; state: "queued" | "running" | "succeeded" | "failed"; createdAt: string;
  completedAt: string | null; fingerprint: string; accountCount: number; settings: Omit<AccountImportRequest, "content">;
  inputArchive: { stored: true; fileName: string };
  logs: ImportLog[]; result: Record<string, unknown> | null; accounting: Record<string, unknown> | null; error: string | null;
}

function parsePayload(content: string): { accountCount: number; fingerprint: string } {
  if (Buffer.byteLength(content, "utf8") > 10 * 1024 * 1024) throw new Error("JSON 文件不能超过 10 MiB");
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error("JSON 内容格式无效"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON 顶层必须是对象");
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.accounts) || !Array.isArray(payload.proxies)) throw new Error("JSON 必须包含 accounts 和 proxies 数组");
  if (payload.accounts.length < 1 || payload.accounts.length > 100) throw new Error("账号数量必须为 1 至 100");
  return { accountCount: payload.accounts.length, fingerprint: createHash("sha256").update(content).digest("hex").slice(0, 16) };
}

function validate(input: AccountImportRequest): void {
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 1000) throw new Error("优先级必须为 1 至 1000");
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 100000) throw new Error("容量必须为正整数");
  if (!Array.isArray(input.groupIds) || input.groupIds.length === 0 || input.groupIds.some((id) => !Number.isInteger(id) || id < 1)) throw new Error("至少选择一个有效分组");
  if (!Number.isInteger(input.sourceProxyId) || input.sourceProxyId < 3) throw new Error("代理池基准 ID 必须是不小于 3 的正整数");
  if (!Number.isFinite(input.unitCostCny) || input.unitCostCny <= 0
    || Math.abs(Math.round(input.unitCostCny * 100) - input.unitCostCny * 100) > 1e-8) {
    throw new Error("账号单价必须为正数人民币，最多两位小数");
  }
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
  constructor(private config: AppConfig, private reads: Sub2ApiReadClient) {}

  options() {
    return { ok: true, currency: "CNY", defaults: { ...this.config.operations.accountImportDefaults, unitCostCny: null }, groups: [
      { id: 2, name: "混池（unidesk-codex-pool）" }, { id: 3, name: "自用" }, { id: 6, name: "Grok" },
    ] };
  }

  submit(input: AccountImportRequest): ImportJob {
    validate(input);
    const parsed = parsePayload(input.content);
    const id = randomUUID();
    const archiveFileName = archiveAccountImportContent(this.config.operations.accountImportArchiveDirectory, id, input.content);
    const job: ImportJob = { id, state: "queued", createdAt: new Date().toISOString(), completedAt: null, ...parsed,
      settings: { priority: input.priority, capacity: input.capacity, groupIds: [...new Set(input.groupIds)], sourceProxyId: input.sourceProxyId, unitCostCny: input.unitCostCny, confirm: input.confirm },
      inputArchive: { stored: true, fileName: archiveFileName },
      logs: [], result: null, accounting: null, error: null };
    this.jobs.set(id, job);
    while (this.jobs.size > 20) this.jobs.delete(this.jobs.keys().next().value!);
    void this.run(job, input.content);
    return this.project(job);
  }

  get(id: string): ImportJob | null { const job = this.jobs.get(id); return job ? this.project(job) : null; }
  inspect(accountIds: number[]): Promise<Record<string, unknown>> { return inspectAccounts(accountIds, this.reads); }
  private project(job: ImportJob): ImportJob { return structuredClone(job); }
  private log(job: ImportJob, stage: string, state: string, message: string) {
    job.logs.push({ timestamp: new Date().toISOString(), stage, state, message: safeMessage(message) });
  }

  private async run(job: ImportJob, content: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "apistate-import-"));
    const file = join(dir, "accounts.json");
    try {
      job.state = "running"; this.log(job, "job", "start", `开始处理 ${job.accountCount} 个账号`);
      const plan = await accountImportPreflight(content, job.settings, this.reads);
      for (const skipped of plan.skipped) {
        this.log(job, "account", "skipped", `stage=account state=skipped index=${skipped.index}/${job.accountCount} account-id=${skipped.accountId}`);
      }
      this.log(job, "proxy", "planned", `代理池候选 ${plan.proxyCandidateIds.length} 个，将为每个新建或更新账号独立随机分配`);
      if (plan.sourceIndexes.length === 0) {
        job.result = completedWithoutWrites(job, plan);
        job.state = "succeeded";
        this.log(job, "job", "done", "全部账号已导入并对齐，本轮未写入");
        return;
      }
      writeFileSync(file, plan.content, { encoding: "utf8", mode: 0o600 });
      const args = [this.config.monitor.cli.entrypoint, "platform-infra", "sub2api", "codex-pool", "runtime", "import",
        "--file", file, "--target", this.config.monitor.target, "--priority", String(job.settings.priority),
        "--capacity", String(job.settings.capacity), "--groups", job.settings.groupIds.join(","),
        "--source-proxy-id", String(job.settings.sourceProxyId), "--proxy-id", String(plan.initialProxyId),
        "--proxy-pool-ids", plan.proxyCandidateIds.join(","), "--json"];
      if (job.settings.confirm) args.push("--confirm");
      const child = Bun.spawn([this.config.monitor.cli.executable, ...args], { cwd: this.config.monitor.cli.workDir, stdout: "pipe", stderr: "pipe", env: process.env });
      const stderrTask = this.captureProgress(job, child.stderr, plan);
      const stdout = await new Response(child.stdout).text();
      const exitCode = await child.exited; await stderrTask;
      const output = JSON.parse(stdout) as Record<string, unknown>;
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
        output.verification = await verifyImportedAccounts(verifiedIds, job.settings, plan.proxyCandidateIds, this.reads);
        const verification = output.verification as Record<string, unknown>;
        this.log(job, "verification", verification.ok === true ? "done" : "failed",
          `账号终态校验 ${verification.aligned}/${verification.selected} 对齐`);
      }
      if (job.settings.confirm && createdIds.length > 0) {
        job.accounting = recordAccountImportCosts({
          path: this.config.operations.accountImportLedgerPath,
          fingerprint: job.fingerprint,
          accountIds: createdIds,
          unitCostCny: job.settings.unitCostCny,
          occurredOn: new Date().toLocaleDateString("sv-SE", { timeZone: this.config.monitor.timezone }),
        });
        const accounting = job.accounting;
        this.log(job, "accounting", "recorded", `人民币采购成本已记账 ${accounting.recordedCount} 个账号，共 ¥${Number(accounting.totalCostCny).toFixed(2)}`);
        output.accounting = accounting;
      }
      const verification = output.verification as Record<string, unknown> | undefined;
      if (exitCode !== 0 || output.ok === false || verification?.ok === false) {
        job.state = "failed";
        job.error = verification?.ok === false ? "导入后的账号配置未全部对齐，请查看 verification.accounts" : importFailure(output);
        this.log(job, "job", "failed", job.error);
        return;
      }
      job.state = "succeeded"; this.log(job, "job", "done", "导入作业完成");
    } catch (error) {
      job.state = "failed"; job.error = safeMessage(error instanceof Error ? error.message : String(error));
      this.log(job, "job", "failed", job.error);
    } finally {
      rmSync(dir, { recursive: true, force: true }); job.completedAt = new Date().toISOString();
    }
  }

  private async captureProgress(job: ImportJob, stream: ReadableStream<Uint8Array>, plan: AccountImportPreflightPlan): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    const consume = (line: string) => {
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
    };
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    pending += decoder.decode();
    consume(pending);
  }
}

function completedWithoutWrites(job: ImportJob, plan: AccountImportPreflightPlan): Record<string, unknown> {
  return {
    ok: true,
    action: "platform-infra-sub2api-codex-pool-runtime-import",
    mode: "confirmed",
    mutation: false,
    file: { fingerprint: job.fingerprint, accountCount: job.accountCount, valuesPrinted: false },
    settings: { ...job.settings, assignmentMode: "per-account-random", proxyCandidateCount: plan.proxyCandidateIds.length },
    result: { createdIds: [], updatedIds: [], skippedIds: plan.skipped.map((item) => item.accountId), skipped: plan.skipped.length, failed: 0, failures: [], isolated: 0 },
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
