import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config";
import type { ImportJob } from "./account-import-service";
import type { BugTeamClient } from "./bugteam-client";
import type { TemporalGateway } from "./temporal-client";
import { selectLowestBugTeamShelf } from "./bugteam-pricing";

export interface BugTeamPurchaseRequest {
  quantity: number;
  priority: number;
  capacity: number;
  rateMultiplier?: number;
  groupIds: number[];
  sourceProxyId: number;
  perAccountProxy?: boolean;
}

export interface PurchaseLog { timestamp: string; stage: string; state: string; message: string }
export interface BugTeamPurchaseJob {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  completedAt: string | null;
  settings: BugTeamPurchaseRequest & { product: "team_1h"; planType: "team" };
  quote: { available: number; estimatedUnitPriceCny: number; estimatedTotalCny: number; holdTotalCny: number; bucketStart: string } | null;
  order: { id: string; state: string; unitCostCny: number | null; totalCostCny: number | null } | null;
  importJobId: string | null;
  importJob: ImportJob | null;
  logs: PurchaseLog[];
  error: string | null;
  workflow?: { workflowId: string; runId: string; state: "submitted" };
}

export type BugTeamPurchaseJobPatch = Partial<Pick<BugTeamPurchaseJob,
  "state" | "completedAt" | "quote" | "order" | "importJobId" | "importJob" | "logs" | "error">>;

export interface BugTeamPurchaseJobControl {
  get(id: string): Promise<BugTeamPurchaseJob | null>;
  patch(id: string, patch: BugTeamPurchaseJobPatch): Promise<void>;
}

export interface AccountImportGateway {
  submit(input: Record<string, unknown>): Promise<ImportJob>;
  get(id: string): Promise<ImportJob | null>;
}

function safeMessage(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/(cfk_[A-Za-z0-9_-]+|rt\.[A-Za-z0-9._-]+|Bearer\s+\S+)/gu, "[REDACTED]")
    .slice(0, 500);
}

function numberField(value: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const numeric = Number(value[name]);
    if (Number.isFinite(numeric)) return numeric;
  }
  for (const nested of Object.values(value)) {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    const found = numberField(nested as Record<string, unknown>, names);
    if (found !== null) return found;
  }
  return null;
}

function stringField(value: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    if (typeof value[name] === "string" && String(value[name]).trim()) return String(value[name]).trim();
  }
  for (const nested of Object.values(value)) {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    const found = stringField(nested as Record<string, unknown>, names);
    if (found) return found;
  }
  return null;
}

function validate(input: BugTeamPurchaseRequest): void {
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 1000) throw new Error("购买数量必须为 1 至 1000");
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 1000) throw new Error("优先级必须为 1 至 1000");
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 100000) throw new Error("容量必须为正整数");
  if (input.rateMultiplier !== undefined && (!Number.isInteger(input.rateMultiplier) || input.rateMultiplier < 1 || input.rateMultiplier > 1000000)) throw new Error("负载因子必须为 1 至 1000000 的整数");
  if (!Array.isArray(input.groupIds) || input.groupIds.length === 0 || input.groupIds.some((id) => !Number.isInteger(id) || id < 1)) throw new Error("至少选择一个有效分组");
  if (!Number.isInteger(input.sourceProxyId) || input.sourceProxyId < 3) throw new Error("代理池基准 ID 必须不小于 3");
}

export class BugTeamPurchaseImportService {
  private jobs = new Map<string, BugTeamPurchaseJob>();

  constructor(
    private readonly config: AppConfig,
    private readonly temporal: TemporalGateway | null = null,
    private readonly workerJobs: BugTeamPurchaseJobControl | null = null,
    private readonly client: BugTeamClient | null = null,
    private readonly imports: AccountImportGateway | null = null,
  ) {}

  options() {
    const defaults = this.config.operations.accountImportDefaults;
    return {
      ok: true,
      product: "team_1h",
      planType: "team",
      defaults: {
        priority: defaults.priority,
        capacity: 16,
        rateMultiplier: defaults.rateMultiplier,
        groupIds: [...defaults.groupIds],
        sourceProxyId: defaults.sourceProxyId,
        perAccountProxy: defaults.perAccountProxy,
      },
      groups: [{ id: 2, name: "混合池" }, { id: 3, name: "自用" }, { id: 6, name: "Grok" }],
    };
  }

  async submit(input: BugTeamPurchaseRequest): Promise<BugTeamPurchaseJob> {
    const normalized = { ...input, rateMultiplier: input.rateMultiplier ?? this.config.operations.accountImportDefaults.rateMultiplier, groupIds: [...new Set(input.groupIds)], perAccountProxy: input.perAccountProxy ?? false };
    validate(normalized);
    const id = randomUUID();
    const job: BugTeamPurchaseJob = {
      id,
      state: "queued",
      createdAt: new Date().toISOString(),
      completedAt: null,
      settings: { ...normalized, product: "team_1h", planType: "team" },
      quote: null,
      order: null,
      importJobId: null,
      importJob: null,
      logs: [{ timestamp: new Date().toISOString(), stage: "job", state: "queued", message: `已提交购买 ${normalized.quantity} 个 Team 账号` }],
      error: null,
    };
    this.jobs.set(id, job);
    while (this.jobs.size > 20) this.jobs.delete(this.jobs.keys().next().value!);
    if (!this.temporal) throw new Error("Temporal worker 当前不可用");
    try {
      job.workflow = await this.temporal.submit({ kind: "bugteam.purchase.import", jobId: id });
    } catch (error) {
      job.state = "failed";
      job.error = safeMessage(error);
      job.completedAt = new Date().toISOString();
      this.log(job, "job", "failed", job.error);
      throw error;
    }
    return this.project(job);
  }

  get(id: string): BugTeamPurchaseJob | null { const job = this.jobs.get(id); return job ? this.project(job) : null; }
  workerGet(id: string): BugTeamPurchaseJob | null { return this.get(id); }

  applyWorkerPatch(id: string, patch: BugTeamPurchaseJobPatch) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("购买作业不存在");
    Object.assign(job, structuredClone(patch));
    return { ok: true, job: this.project(job), valuesPrinted: false };
  }

  async runWorker(id: string): Promise<BugTeamPurchaseJob> {
    if (!this.workerJobs || !this.client || !this.imports) throw new Error("BugTeam 购买 worker 控制面不可用");
    const job = await this.workerJobs.get(id);
    if (!job) throw new Error("购买作业不存在");
    if (job.state === "succeeded" || job.state === "failed") return job;
    try {
      job.state = "running";
      this.log(job, "quote", "start", "正在刷新库存与成交报价");
      await this.persist(job);
      const [shelves, inventory] = await Promise.all([
        this.client.inventoryShelves("team_1h"),
        this.client.inventory("team_1h", job.settings.quantity),
      ]);
      const selected = selectLowestBugTeamShelf(shelves, inventory, job.settings.quantity);
      const holdTotalFen = numberField(inventory, ["hold_total_fen"]);
      if (!selected || holdTotalFen === null) {
        throw new Error(`当前没有能以单一最低价车次满足整单的库存：需要 ${job.settings.quantity}`);
      }
      job.quote = {
        available: selected.available,
        estimatedUnitPriceCny: selected.unitPriceFen / 100,
        estimatedTotalCny: selected.unitPriceFen * job.settings.quantity / 100,
        holdTotalCny: holdTotalFen / 100,
        bucketStart: selected.bucketStart,
      };
      this.log(job, "quote", "done", `最新报价 ¥${job.quote.estimatedUnitPriceCny.toFixed(2)} / 个，锁款 ¥${job.quote.holdTotalCny.toFixed(2)}`);
      await this.persist(job);

      if (!job.order?.id) {
        this.log(job, "order", "start", "正在创建幂等购买订单");
        await this.persist(job);
        const created = await this.client.createOrder("team_1h", job.settings.quantity, `api2business-bugteam-purchase-${job.id}`, job.quote.bucketStart);
        const orderId = stringField(created, ["order_id", "id"]);
        if (!orderId) throw new Error("BugTeam 创建订单后未返回 order_id");
        job.order = { id: orderId, state: stringField(created, ["state", "status"]) ?? "created", unitCostCny: null, totalCostCny: null };
        this.log(job, "order", "done", `订单 ${orderId} 已创建`);
        await this.persist(job);
      }

      let status: Record<string, unknown> = {};
      for (;;) {
        status = await this.client.orderStatus(job.order.id);
        const state = (stringField(status, ["state", "status"]) ?? "unknown").toLowerCase();
        job.order.state = state;
        this.log(job, "fulfillment", state === "completed" ? "done" : "waiting", state === "completed" ? "订单已履约" : `等待订单履约：${state}`);
        await this.persist(job);
        if (state === "completed") break;
        if (["cancelled", "canceled", "expired", "failed"].includes(state)) throw new Error(`BugTeam 订单终止：${state}`);
        await Bun.sleep(3000);
      }

      const finalTotalFen = numberField(status, ["actual_total_fen", "settled_total_fen", "final_total_fen", "charged_fen", "total_fen", "estimated_total_fen"])
        ?? Math.round(job.quote.estimatedTotalCny * 100);
      job.order.totalCostCny = finalTotalFen / 100;
      job.order.unitCostCny = Math.round((job.order.totalCostCny / job.settings.quantity) * 100) / 100;
      const outputPath = join(this.config.operations.accountImportArchiveDirectory, "bugteam-purchases", `${job.id}.json`);
      if (!existsSync(outputPath)) {
        this.log(job, "download", "start", "正在下载 Sub2 JSON");
        await this.persist(job);
        const download = await this.client.download(job.order.id, "sub2", outputPath);
        this.log(job, "download", "done", `Sub2 JSON 已校验，${Number(download.bytes ?? 0)} bytes`);
      } else {
        this.log(job, "download", "reused", "复用已校验的 Sub2 JSON 下载结果");
      }

      if (!job.importJobId) {
        const importJob = await this.imports.submit({
          content: readFileSync(outputPath, "utf8"),
          inputFormat: "json",
          priority: job.settings.priority,
          capacity: job.settings.capacity,
          rateMultiplier: job.settings.rateMultiplier,
          groupIds: job.settings.groupIds,
          sourceProxyId: job.settings.sourceProxyId,
          perAccountProxy: job.settings.perAccountProxy,
          unitCostCny: job.order.unitCostCny,
          planType: "team",
          platform: "openai",
          cutoffTrigger: "bugteam-import",
          confirm: true,
        });
        job.importJobId = importJob.id;
        job.importJob = importJob;
        this.log(job, "import", "queued", `账号导入作业 ${importJob.id} 已提交`);
        await this.persist(job);
      }

      let importedLogCount = 0;
      for (;;) {
        const importJob = await this.imports.get(job.importJobId);
        if (!importJob) throw new Error("账号导入作业不存在");
        job.importJob = importJob;
        for (const entry of importJob.logs.slice(importedLogCount)) this.log(job, `import/${entry.stage}`, entry.state, entry.message);
        importedLogCount = importJob.logs.length;
        await this.persist(job);
        if (importJob.state === "succeeded") break;
        if (importJob.state === "failed") throw new Error(importJob.error ?? "账号导入失败");
        await Bun.sleep(1000);
      }
      job.state = "succeeded";
      job.completedAt = new Date().toISOString();
      this.log(job, "job", "done", "购买、履约、导入和记账已全部完成");
      await this.persist(job);
      return job;
    } catch (error) {
      job.state = "failed";
      job.completedAt = new Date().toISOString();
      job.error = safeMessage(error);
      this.log(job, "job", "failed", job.error);
      await this.persist(job);
      throw error;
    }
  }

  private project(job: BugTeamPurchaseJob): BugTeamPurchaseJob { return structuredClone(job); }
  private log(job: BugTeamPurchaseJob, stage: string, state: string, message: string) {
    job.logs.push({ timestamp: new Date().toISOString(), stage, state, message: safeMessage(message) });
  }
  private async persist(job: BugTeamPurchaseJob) {
    if (!this.workerJobs) return;
    await this.workerJobs.patch(job.id, {
      state: job.state,
      completedAt: job.completedAt,
      quote: job.quote,
      order: job.order,
      importJobId: job.importJobId,
      importJob: job.importJob,
      logs: job.logs,
      error: job.error,
    });
  }
}
