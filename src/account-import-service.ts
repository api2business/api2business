import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config";

export interface AccountImportRequest {
  content: string;
  priority: number;
  capacity: number;
  groupIds: number[];
  sourceProxyId: number;
  shadowProxy: boolean;
  confirm: boolean;
}

interface ImportLog { timestamp: string; stage: string; state: string; message: string }
interface ImportJob {
  id: string; state: "queued" | "running" | "succeeded" | "failed"; createdAt: string;
  completedAt: string | null; fingerprint: string; accountCount: number; settings: Omit<AccountImportRequest, "content">;
  logs: ImportLog[]; result: Record<string, unknown> | null; error: string | null;
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
  if (!Number.isInteger(input.sourceProxyId) || input.sourceProxyId < 1) throw new Error("Proxy ID 必须为正整数");
}

function safeMessage(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]+/gu, "[REDACTED]").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/gu, "[REDACTED]").slice(0, 500);
}

export class AccountImportService {
  private jobs = new Map<string, ImportJob>();
  constructor(private config: AppConfig) {}

  options() {
    return { ok: true, defaults: { priority: 1, capacity: 5, groupIds: [2, 3], sourceProxyId: 3, shadowProxy: true }, groups: [
      { id: 2, name: "混池（unidesk-codex-pool）" }, { id: 3, name: "自用" }, { id: 6, name: "Grok" },
    ] };
  }

  submit(input: AccountImportRequest): ImportJob {
    validate(input);
    const parsed = parsePayload(input.content);
    const id = randomUUID();
    const job: ImportJob = { id, state: "queued", createdAt: new Date().toISOString(), completedAt: null, ...parsed,
      settings: { priority: input.priority, capacity: input.capacity, groupIds: [...new Set(input.groupIds)], sourceProxyId: input.sourceProxyId, shadowProxy: input.shadowProxy, confirm: input.confirm },
      logs: [], result: null, error: null };
    this.jobs.set(id, job);
    while (this.jobs.size > 20) this.jobs.delete(this.jobs.keys().next().value!);
    void this.run(job, input.content);
    return this.project(job);
  }

  get(id: string): ImportJob | null { const job = this.jobs.get(id); return job ? this.project(job) : null; }
  private project(job: ImportJob): ImportJob { return structuredClone(job); }
  private log(job: ImportJob, stage: string, state: string, message: string) {
    job.logs.push({ timestamp: new Date().toISOString(), stage, state, message: safeMessage(message) });
  }

  private async run(job: ImportJob, content: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "apistate-import-"));
    const file = join(dir, "accounts.json");
    try {
      writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
      job.state = "running"; this.log(job, "job", "start", `开始处理 ${job.accountCount} 个账号`);
      const args = [this.config.monitor.cli.entrypoint, "platform-infra", "sub2api", "codex-pool", "runtime", "import",
        "--file", file, "--target", this.config.monitor.target, "--priority", String(job.settings.priority),
        "--capacity", String(job.settings.capacity), "--groups", job.settings.groupIds.join(","),
        "--source-proxy-id", String(job.settings.sourceProxyId), "--shadow-proxy", String(job.settings.shadowProxy), "--json"];
      if (job.settings.confirm) args.push("--confirm");
      const child = Bun.spawn([this.config.monitor.cli.executable, ...args], { cwd: this.config.monitor.cli.workDir, stdout: "pipe", stderr: "pipe", env: process.env });
      const stderrTask = (async () => { for await (const line of child.stderr) {
        const text = new TextDecoder().decode(line).trim();
        if (!text) continue;
        const stage = /stage=([^ ]+)/u.exec(text)?.[1] ?? "runtime";
        const state = /state=([^ ]+)/u.exec(text)?.[1] ?? "progress";
        this.log(job, stage, state, text.replace(/^.*?PROGRESS\s+/u, ""));
      } })();
      const stdout = await new Response(child.stdout).text();
      const exitCode = await child.exited; await stderrTask;
      const output = JSON.parse(stdout) as Record<string, unknown>;
      if (exitCode !== 0 || output.ok === false) throw new Error(typeof output.error === "string" ? output.error : "runtime 导入失败");
      job.result = output; job.state = "succeeded"; this.log(job, "job", "done", "导入作业完成");
    } catch (error) {
      job.state = "failed"; job.error = safeMessage(error instanceof Error ? error.message : String(error));
      this.log(job, "job", "failed", job.error);
    } finally {
      rmSync(dir, { recursive: true, force: true }); job.completedAt = new Date().toISOString();
    }
  }
}
