import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { AppConfig } from "./config";
import { collectRecentCallScoresFromDatabase } from "./account-score-database";
import { buildAccountPriorityPlan } from "./account-priority-plan";
import { collectErrorAggregateFromDatabase } from "./error-aggregate-database";
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
import type {
  Sub2ApiReadClient,
  Sub2ApiReadPriority,
} from "./sub2api-read-executor";
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
import { readAccountImportCosts } from "./account-import-cost-ledger";
import {
  collectAccountImportEconomics,
  type AccountImportEconomicsInput,
} from "./account-import-economics";

const prioritiesByIdSql = `
SELECT id::text AS id, priority::int AS priority
FROM accounts
WHERE id = ANY(string_to_array($1, ',')::bigint[])
`;

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row))
    : [];
}

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class OperationsService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: OperationsStore,
    private readonly reads: Sub2ApiReadClient,
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

  async ledger(period = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 7)) {
    const yaml = this.yamlLedger();
    const accountImports = readAccountImportCosts(this.config.operations.accountImportLedgerPath)
      .filter((entry) => entry.period === period)
      .map((entry) => ({ ...entry, readOnly: true }));
    const manual = await this.store.listCash();
    const active = records(manual).filter((row) => !row.voided_at && String(row.occurred_on).slice(0, 7) === period);
    const alipay = await this.alipay(period);
    const incomeCny = yaml.revenues.filter((row) => row.period === period).reduce((sum, row) => sum + money(row.amountCny), 0)
      + active.filter((row) => row.direction === "income").reduce((sum, row) => sum + money(row.amount_cny), 0);
    const expenseCny = yaml.costs.filter((row) => row.period === period).reduce((sum, row) => sum + money(row.amountCny), 0)
      + active.filter((row) => row.direction === "expense").reduce((sum, row) => sum + money(row.amount_cny), 0)
      + accountImports.reduce((sum, row) => sum + money(row.amountCny), 0);
    const totalIncomeCny = incomeCny + alipay.revenueCny;
    return {
      ok: true, period, yaml, manual, accountImports, alipay,
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
    const result = buildAccountPriorityPlan(ranking, this.config);
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
    const args = [
      this.config.monitor.cli.entrypoint, "platform-infra", "sub2api", "codex-pool", "runtime", "apply",
      "--target", this.config.monitor.target, "--kind", "priority",
      "--priorities-json", JSON.stringify(priorities), "--write-only", "--confirm",
    ];
    const proc = Bun.spawn([this.config.monitor.cli.executable, ...args], {
      cwd: this.config.monitor.cli.workDir, stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, UNIDESK_MAIN_SERVER_IP: this.config.monitor.cli.mainServerHost },
    });
    const startedAt = Date.now();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, this.config.monitor.cli.timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    clearTimeout(timeout);
    return {
      ok: !timedOut && exitCode === 0,
      exitCode,
      timedOut,
      writeDurationMs: Date.now() - startedAt,
      outputAvailable: stdout.length > 0,
      error: stderr.slice(-1000),
    };
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

  async procurement(budgetCny: number, operator: string) {
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
    const result = { ok: true, budgetCny, allocatedCny: budgetCny - remaining, unallocatedCny: remaining, allocations, deterministic: true, llmCalls: 0 };
    await this.store.audit("procurement.calculate", "succeeded", operator,
      { budgetCny }, { allocatedCny: result.allocatedCny, unallocatedCny: remaining, siteCount: new Set(allocations.map((row) => row.billingSite)).size });
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

  async oauthImportEconomics(day: string) {
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
    const procurementRefundCny = yaml.revenues
      .filter((entry) => entry.kind === "procurement-refund" && entry.occurredOn === day)
      .reduce((sum, entry) => sum + money(entry.amountCny), 0);
    const netAcquisitionCostCny = Math.max(0, grossAcquisitionCostCny - procurementRefundCny);
    const apiAmountUsd = Number(total.apiAmountUsd);
    return {
      ...facts,
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

  async audits() {
    return { ok: true, records: await this.store.audits(this.config.operations.auditLimit) };
  }
}
