import { DateTime } from "luxon";
import { createHash, randomInt, randomUUID } from "node:crypto";
import type { AppConfig, IdentityField } from "./config";
import { LotteryStore } from "./store";
import { Sub2ApiClient } from "./sub2api-client";
import type { DrawRecord, PublicDrawRecord, PublicRankingRow, Sub2ApiUser } from "./types";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import { collectUserRanking } from "./user-ranking-database";

class Mutex {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function identityValues(user: Sub2ApiUser, fields: IdentityField[]): string[] {
  return fields.map((field) => {
    if (field === "username") return normalized(user.username ?? "");
    if (field === "email") return normalized(user.email ?? "");
    return normalized((user.email ?? "").split("@", 1)[0] ?? "");
  }).filter(Boolean);
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@", 2);
  if (!domain) return "匿名用户";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(2, Math.min(5, local.length - visible.length)))}@${domain}`;
}

function displayName(user: Sub2ApiUser): string {
  return user.username.trim() || maskEmail(user.email);
}

export function rankingDisplayName(user: Sub2ApiUser): string {
  return user.email.trim() || user.username.trim() || "匿名用户";
}

export class LotteryService {
  private readonly mutex = new Mutex();

  constructor(
    readonly config: AppConfig,
    private readonly store: LotteryStore,
    private readonly sub2api: Sub2ApiClient,
    private readonly reads: Sub2ApiReadClient | null = null,
  ) {}

  private excluded(user: Sub2ApiUser): boolean {
    const eligibility = this.config.lottery.eligibility;
    const roles = new Set(eligibility.excludedRoles.map(normalized));
    const statuses = new Set(eligibility.statuses.map(normalized));
    const identities = new Set(eligibility.excludedIdentities.map(normalized));
    return roles.has(normalized(user.role)) || !statuses.has(normalized(user.status)) || identityValues(user, eligibility.identityFields).some((value) => identities.has(value));
  }

  async eligibleUsers(now = new Date()): Promise<Sub2ApiUser[]> {
    const cutoff = now.getTime() - this.config.lottery.eligibility.activeWithinHours * 60 * 60 * 1000;
    return (await this.sub2api.listUsers()).filter((user) => {
      if (this.excluded(user) || !user.last_active_at) return false;
      const activeAt = Date.parse(user.last_active_at);
      return Number.isFinite(activeAt) && activeAt >= cutoff && activeAt <= now.getTime();
    });
  }

  async ranking(now = new Date()): Promise<{ rows: PublicRankingRow[]; totals: { actualCost: number; requests: number; tokens: number; balanceUsd: number; rechargeCny: number }; startDate: string; endDate: string; queryCompletedAt?: string; databaseQueries?: number }> {
    const local = DateTime.fromJSDate(now, { zone: this.config.ranking.timezone });
    const startDate = local.minus({ days: this.config.ranking.windowDays - 1 }).toISODate();
    const endDate = local.toISODate();
    if (!startDate || !endDate) throw new Error("failed to calculate ranking date range");
    if (this.reads) {
      const start = local.minus({ days: this.config.ranking.windowDays - 1 }).startOf("day").toUTC().toISO()!;
      const end = local.plus({ days: 1 }).startOf("day").toUTC().toISO()!;
      const todayStart = local.startOf("day").toUTC().toISO()!;
      const query = await collectUserRanking(this.reads, start, end, todayStart, this.config.ranking.sourceLimit);
      const sourceRows = query.rows.map((row) => ({
        user: {
          id: Number(row.user_id), username: String(row.username ?? ""), email: String(row.email ?? ""),
          role: String(row.role ?? ""), status: String(row.status ?? ""), balance: Number(row.balance ?? 0),
        },
        actualCost: Number(row.actual_cost ?? 0), requests: Number(row.requests ?? 0),
        tokens: Number(row.tokens ?? 0), rechargeCny: Number(row.recharge_cny ?? 0),
      })).filter(({ user }) => !this.excluded(user));
      const rows = sourceRows.slice(0, this.config.ranking.displayLimit).map((row, index) => ({
        rank: index + 1, displayName: rankingDisplayName(row.user), actualCost: row.actualCost,
        requests: row.requests, tokens: row.tokens, balanceUsd: row.user.balance, rechargeCny: row.rechargeCny,
      }));
      return {
        rows,
        totals: sourceRows.reduce((totals, row) => ({
          actualCost: totals.actualCost + row.actualCost,
          requests: totals.requests + row.requests,
          tokens: totals.tokens + row.tokens,
          balanceUsd: totals.balanceUsd + Math.max(0, row.user.balance),
          rechargeCny: totals.rechargeCny + row.rechargeCny,
        }), { actualCost: 0, requests: 0, tokens: 0, balanceUsd: 0, rechargeCny: 0 }),
        startDate, endDate, queryCompletedAt: query.queryCompletedAt, databaseQueries: query.cached ? 0 : 1,
      };
    }
    const [source, users] = await Promise.all([this.sub2api.getUsageRanking(startDate, endDate), this.sub2api.listUsers()]);
    const userMap = new Map(users.map((user) => [user.id, user]));
    const filtered = source.ranking
      .map((row) => ({ row, user: userMap.get(row.user_id) }))
      .filter((item): item is { row: typeof item.row; user: Sub2ApiUser } => Boolean(item.user) && !this.excluded(item.user!));
    const rows = filtered
      .slice(0, this.config.ranking.displayLimit)
      .map(({ row, user }, index) => ({
        rank: index + 1,
        displayName: rankingDisplayName(user),
        actualCost: row.actual_cost,
        requests: row.requests,
        tokens: row.tokens,
        balanceUsd: user.balance,
        rechargeCny: 0,
      }));
    return {
      rows,
      totals: filtered.reduce((totals, { row, user }) => ({
        actualCost: totals.actualCost + row.actual_cost,
        requests: totals.requests + row.requests,
        tokens: totals.tokens + row.tokens,
        balanceUsd: totals.balanceUsd + Math.max(0, user.balance),
        rechargeCny: totals.rechargeCny,
      }), { actualCost: 0, requests: 0, tokens: 0, balanceUsd: 0, rechargeCny: 0 }),
      startDate,
      endDate,
    };
  }

  private publicRecord(record: DrawRecord): PublicDrawRecord {
    return {
      id: record.id,
      drawnAt: record.drawnAt,
      eligibleCount: record.eligibleCount,
      winnerDisplayName: record.winnerDisplayName,
      prizeAmountUsd: record.prizeAmountUsd,
      creditStatus: record.creditStatus,
    };
  }

  async publicState(): Promise<Record<string, unknown>> {
    const state = await this.status(true);
    return {
      ...state,
      records: this.store.listRecords(this.config.records.publicLimit).map((record) => this.publicRecord(record)),
      rankingWindowDays: this.config.ranking.windowDays,
    };
  }

  async publicDraw(): Promise<PublicDrawRecord> {
    return this.publicRecord(await this.draw());
  }

  async status(includeLiveData = false): Promise<Record<string, unknown>> {
    const grants = this.store.reconcileGrants();
    const result: Record<string, unknown> = {
      ok: true,
      remainingDraws: grants.remainingDraws,
      nextGrantAt: grants.nextGrantAt,
      dailyGrantCount: this.config.lottery.dailyGrant.count,
      prizeAmountUsd: this.config.lottery.prize.amountUsd,
      activeWithinHours: this.config.lottery.eligibility.activeWithinHours,
      automaticCredit: {
        enabled: this.config.lottery.automaticCredit.enabled,
        mode: this.config.lottery.automaticCredit.mode,
      },
      records: this.store.listRecords(this.config.records.publicLimit),
    };
    if (includeLiveData) {
      const [eligible, ranking] = await Promise.all([this.eligibleUsers(), this.ranking()]);
      result.eligibleUserCount = eligible.length;
      result.ranking = ranking;
    }
    return result;
  }

  async draw(): Promise<DrawRecord> {
    return await this.mutex.run(async () => {
      const state = this.store.reconcileGrants();
      if (state.remainingDraws < 1) throw new Error("no draw chance is available");
      const users = await this.eligibleUsers();
      if (users.length === 0) throw new Error("no eligible user was active in the configured window");
      const winner = users[randomInt(users.length)]!;
      const record: DrawRecord = {
        id: randomUUID(),
        drawnAt: new Date().toISOString(),
        eligibleCount: users.length,
        winnerUserId: winner.id,
        winnerDisplayName: displayName(winner),
        prizeAmountUsd: this.config.lottery.prize.amountUsd,
        creditStatus: this.config.lottery.automaticCredit.enabled ? (this.config.lottery.automaticCredit.mode === "dry-run" ? "dry_run" : "pending") : "disabled",
        creditMessage: this.config.lottery.automaticCredit.enabled ? (this.config.lottery.automaticCredit.mode === "dry-run" ? "YAML dry-run：未修改账户额度" : "等待自动充值") : "YAML 开关关闭：未修改账户额度",
      };
      this.store.createDraw(record);
      if (this.config.lottery.automaticCredit.enabled && this.config.lottery.automaticCredit.mode === "live") {
        try {
          await this.sub2api.addBalance(winner.id, record.prizeAmountUsd, `${this.config.lottery.automaticCredit.notesPrefix} ${record.id}`);
          record.creditStatus = "succeeded";
          record.creditMessage = "Sub2API 余额增加成功";
        } catch (error) {
          record.creditStatus = "failed";
          record.creditMessage = error instanceof Error ? error.message : String(error);
        }
        this.store.updateCredit(record.id, record.creditStatus, record.creditMessage);
      }
      return record;
    });
  }

  reset(draws: number, includeRecords: boolean): Record<string, unknown> {
    const result = this.store.resetData(draws, includeRecords);
    return { ok: true, ...result, includeRecords };
  }

  listRecords(limit: number): DrawRecord[] {
    return this.store.listRecords(limit);
  }

  deleteRecord(id: string): Record<string, unknown> {
    const deleted = this.store.deleteRecord(id);
    if (!deleted) throw new Error(`draw record ${id} does not exist`);
    return { ok: true, deletedId: id };
  }

  async creditTest(execute: boolean): Promise<Record<string, unknown>> {
    const test = this.config.lottery.creditTest;
    const users = await this.sub2api.listUsers();
    const target = users.find((user) => normalized(user.role) === "admin" && identityValues(user, test.identityFields).includes(normalized(test.targetIdentifier)));
    if (!target) throw new Error("configured admin credit-test target was not found");
    const plan = {
      ok: true,
      execute,
      targetUserId: target.id,
      targetDisplayName: displayName(target),
      role: target.role,
      amountUsd: test.amountUsd,
      automaticCreditEnabled: this.config.lottery.automaticCredit.enabled,
    };
    if (!execute) return plan;
    const before = target.balance;
    const updated = await this.sub2api.addBalance(target.id, test.amountUsd, test.notes);
    const observedDeltaUsd = Number((updated.balance - before).toFixed(8));
    if (Math.abs(observedDeltaUsd - test.amountUsd) > 0.00000001) throw new Error(`admin credit test delta mismatch: expected ${test.amountUsd}, observed ${observedDeltaUsd}`);
    return {
      ...plan,
      credited: true,
      observedDeltaUsd,
      operationFingerprint: createHash("sha256").update(`${target.id}:${test.amountUsd}:${test.notes}`).digest("hex").slice(0, 16),
    };
  }
}
