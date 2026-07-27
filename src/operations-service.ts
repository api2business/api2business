import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { SQL } from "bun";
import type { AppConfig } from "./config";
import { collectRecentCallScoresFromDatabase } from "./account-score-database";
import { buildAccountPriorityPlan } from "./account-priority-plan";
import { OperationsStore, type CashDirection } from "./operations-store";

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row))
    : [];
}

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class OperationsService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: OperationsStore,
    private readonly scoreDatabaseUrl: string,
  ) {}

  async initialize(): Promise<void> {
    await this.store.migrate();
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private yamlLedger() {
    const root = parse(readFileSync(this.config.operations.ledgerYamlPath, "utf8")) as Record<string, unknown>;
    const profit = root.profit as Record<string, unknown> | undefined;
    const revenues: Array<Record<string, unknown>> = records(profit?.periodRevenues).map((row) => ({ ...row, source: "yaml", readOnly: true }));
    const costs: Array<Record<string, unknown>> = records(profit?.periodCosts).map((row) => ({ ...row, source: "yaml", readOnly: true }));
    return { revenues, costs };
  }

  private async alipay(period: string): Promise<{ completedOrders: number; revenueCny: number }> {
    const sql = new SQL(this.scoreDatabaseUrl, { max: 1 });
    try {
      return await sql.begin(async (tx) => {
        await tx.unsafe("SET TRANSACTION READ ONLY");
        await tx.unsafe(`SET LOCAL statement_timeout = '${this.config.sub2api.scoreDatabase.statementTimeoutMs}ms'`);
        const [row] = await tx`
          SELECT count(*)::int AS completed_orders,
            COALESCE(sum(o.pay_amount), 0)::float8 AS revenue_cny
          FROM payment_orders o JOIN users u ON u.id=o.user_id
          WHERE lower(COALESCE(u.role, '')) <> 'admin'
            AND o.provider_key='alipay' AND o.payment_type='alipay'
            AND o.status='COMPLETED'
            AND to_char(COALESCE(o.paid_at, o.completed_at, o.created_at)
              AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM')=${period}
        `;
        return { completedOrders: Number(row?.completed_orders ?? 0), revenueCny: money(row?.revenue_cny) };
      });
    } finally {
      await sql.close();
    }
  }

  async ledger(period = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 7)) {
    const yaml = this.yamlLedger();
    const manual = await this.store.listCash();
    const active = records(manual).filter((row) => !row.voided_at && String(row.occurred_on).slice(0, 7) === period);
    const alipay = await this.alipay(period);
    const incomeCny = yaml.revenues.filter((row) => row.period === period).reduce((sum, row) => sum + money(row.amountCny), 0)
      + active.filter((row) => row.direction === "income").reduce((sum, row) => sum + money(row.amount_cny), 0);
    const expenseCny = yaml.costs.filter((row) => row.period === period).reduce((sum, row) => sum + money(row.amountCny), 0)
      + active.filter((row) => row.direction === "expense").reduce((sum, row) => sum + money(row.amount_cny), 0);
    const totalIncomeCny = incomeCny + alipay.revenueCny;
    return {
      ok: true, period, yaml, manual, alipay,
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

  async generatePriorityPlan(recentCallLimit: number, operator: string) {
    const result = await this.priorityState(recentCallLimit);
    const priorities = result.priorities as Record<string, number>;
    const plan = await this.store.createPlan({
      operator, recentCallLimit, ttlMinutes: this.config.operations.planTtlMinutes, priorities, result,
    });
    await this.store.audit("priority.plan.generate", "succeeded", operator,
      { recentCallLimit }, { planId: plan.id, changedCount: Object.keys(priorities).length });
    return { ...result, planId: plan.id, expiresAt: plan.expiresAt };
  }

  async priorityState(recentCallLimit: number) {
    const ranking = await collectRecentCallScoresFromDatabase(this.config, recentCallLimit, null, null, this.scoreDatabaseUrl);
    const result = buildAccountPriorityPlan(ranking, this.config);
    return { ...result, refreshedAt: new Date().toISOString() };
  }

  private async verifyPriorities(priorities: Record<string, number>) {
    const expected = new Map(Object.entries(priorities).map(([id, priority]) => [id, Number(priority)]));
    const startedAt = Date.now();
    const deadline = startedAt + this.config.operations.priorityVerificationTimeoutMs;
    let verifiedCount = 0;
    do {
      const sql = new SQL(this.scoreDatabaseUrl, { max: 1 });
      try {
        const rows = await sql.begin(async (tx) => {
          await tx.unsafe("SET TRANSACTION READ ONLY");
          await tx.unsafe(`SET LOCAL statement_timeout = '${this.config.sub2api.scoreDatabase.statementTimeoutMs}ms'`);
          return await tx`SELECT id::text AS id, priority::int AS priority FROM accounts`;
        });
        const actual = new Map(rows.map((row) => [String(row.id), Number(row.priority)]));
        verifiedCount = [...expected].filter(([id, priority]) => actual.get(id) === priority).length;
        if (verifiedCount === expected.size) {
          return {
            verification: "postgresql-direct",
            verifiedCount,
            verificationDurationMs: Date.now() - startedAt,
          };
        }
      } finally {
        await sql.close();
      }
      await Bun.sleep(this.config.operations.priorityVerificationPollMs);
    } while (Date.now() < deadline);
    throw new Error(`优先级写入后 PostgreSQL 回读超时（已验证 ${verifiedCount}/${expected.size}）`);
  }

  async confirmPriorityPlan(id: string, operator: string) {
    const plan = await this.store.getPlan(id);
    if (plan.status !== "pending") throw new Error("priority plan is not pending");
    if (new Date(String(plan.expires_at)).getTime() <= Date.now()) throw new Error("priority plan has expired");
    const priorities = plan.priorities as Record<string, number>;
    const args = [
      this.config.monitor.cli.entrypoint, "platform-infra", "sub2api", "codex-pool", "runtime", "apply",
      "--target", this.config.monitor.target, "--kind", "priority",
      "--priorities-json", JSON.stringify(priorities), "--write-only", "--confirm",
    ];
    const proc = Bun.spawn([this.config.monitor.cli.executable, ...args], {
      cwd: this.config.monitor.cli.workDir, stdout: "pipe", stderr: "pipe",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, this.config.monitor.cli.timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    clearTimeout(timeout);
    const writeResult = {
      exitCode, timedOut, output: stdout.slice(-4000), error: stderr.slice(-1000),
      changedCount: Object.keys(priorities).length, writeMode: "backend-api-only",
    };
    if (timedOut || exitCode !== 0) {
      await this.store.finishPlan(id, "failed", writeResult);
      await this.store.audit("priority.plan.confirm", "failed", operator,
        { planId: id, changedCount: Object.keys(priorities).length },
        { exitCode, timedOut, writeMode: "backend-api-only", verification: "not-started" });
      if (timedOut) throw new Error("优先级调整执行超时");
      throw new Error("优先级调整失败");
    }
    try {
      const verification = await this.verifyPriorities(priorities);
      const result = { ...writeResult, ...verification };
      await this.store.finishPlan(id, "applied", result);
      await this.store.audit("priority.plan.confirm", "succeeded", operator,
        { planId: id, changedCount: Object.keys(priorities).length },
        { exitCode, timedOut, writeMode: "backend-api-only", ...verification });
      return { ok: true, planId: id, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = { ...writeResult, verification: "postgresql-direct", verificationError: message };
      await this.store.finishPlan(id, "failed", result);
      await this.store.audit("priority.plan.confirm", "failed", operator,
        { planId: id, changedCount: Object.keys(priorities).length },
        { exitCode, timedOut, writeMode: "backend-api-only", verification: "postgresql-direct", error: message });
      throw error;
    }
  }

  async procurement(budgetCny: number, operator: string) {
    const ranking = await collectRecentCallScoresFromDatabase(
      this.config, this.config.monitor.recentCallLimit, null, null, this.scoreDatabaseUrl,
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
    const result = { ok: true, budgetCny, allocatedCny: budgetCny - remaining, unallocatedCny: remaining, allocations, deterministic: true, llmCalls: 0 };
    await this.store.audit("procurement.calculate", "succeeded", operator,
      { budgetCny }, { allocatedCny: result.allocatedCny, unallocatedCny: remaining, siteCount: new Set(allocations.map((row) => row.billingSite)).size });
    return result;
  }

  async audits() {
    return { ok: true, records: await this.store.audits(this.config.operations.auditLimit) };
  }
}
