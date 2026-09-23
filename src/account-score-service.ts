import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mergeAccountScores } from "./account-score-aggregation";
import { collectRecentCallScoresFromDatabase } from "./account-score-database";
import { isOAuthAccount } from "./account-score-eligibility";
import type { AppConfig } from "./config";
import type { Sub2ApiClient } from "./sub2api-client";
import type { Sub2ApiReadClient, Sub2ApiReadPriority } from "./sub2api-read-executor";

interface ScoreSnapshot {
  cacheVersion: string;
  ok: boolean;
  status: "ready" | "refreshing" | "stale" | "unavailable";
  refreshedAt: string | null;
  refreshStartedAt: string | null;
  nextRefreshAt: string | null;
  window: string;
  recentCallLimit: number;
  groups: Array<Record<string, unknown>>;
  accounts: Array<Record<string, unknown>>;
  error: string | null;
  source: string;
  collection?: Record<string, unknown>;
}

export interface ScoreSnapshotStore {
  getSnapshot(key: string): Promise<Record<string, unknown> | null>;
  beginSnapshotRefresh(key: string, schemaVersion: string, startedAt: string): Promise<void>;
  completeSnapshot(key: string, schemaVersion: string, payload: Record<string, unknown>, capturedAt: string): Promise<void>;
  failSnapshotRefresh(key: string, schemaVersion: string, error: string): Promise<void>;
}

const scoreCacheVersion = "api-key-only-v1";
const scoreSnapshotKey = "account-scores";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
}

export class AccountScoreService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<ScoreSnapshot> | null = null;
  private snapshot: ScoreSnapshot;

  constructor(
    private readonly config: AppConfig,
    private readonly cachePath: string,
    private readonly sub2api: Sub2ApiClient,
    private readonly reads: Sub2ApiReadClient | null = null,
    private readonly snapshotStore: ScoreSnapshotStore | null = null,
  ) {
    this.snapshot = this.readCache();
  }

  async readLatest(): Promise<ScoreSnapshot> {
    return await this.state();
  }

  async rank(recentCallLimit: number, accountSelector: string | null = null, groupSelector: string | null = null): Promise<Record<string, unknown>> {
    if (!this.config.monitor.recentCallOptions.includes(recentCallLimit)) {
      throw new Error(`recentCallLimit must be one of: ${this.config.monitor.recentCallOptions.join(", ")}`);
    }
    await this.refresh(recentCallLimit, "manual");
    const snapshot = await this.state();
    const accounts = this.selectAccounts(snapshot.accounts, accountSelector, groupSelector);
    return {
      ...snapshot,
      ok: snapshot.refreshedAt !== null,
      accounts,
      accountCount: accounts.length,
      accountSelector,
      groupSelector,
      recentCallLimit: snapshot.recentCallLimit,
      scoringScope: "non-oauth-accounts",
      availableCallOptions: this.config.monitor.recentCallOptions,
      databaseQueries: record(snapshot.collection)?.databaseQueries ?? null,
      queryDurationMs: record(snapshot.collection)?.queryDurationMs ?? null,
    };
  }

  start(): void {
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.config.monitor.refreshIntervalMinutes * 60_000);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async state(): Promise<ScoreSnapshot> {
    if (this.snapshotStore) await this.readPersistentSnapshot();
    else if (!this.inFlight && existsSync(this.cachePath)) this.snapshot = this.readCache();
    const nextRefreshAt = this.snapshot.nextRefreshAt ? Date.parse(this.snapshot.nextRefreshAt) : Number.NaN;
    const status = this.inFlight
      ? "refreshing"
      : this.snapshot.status === "ready" && Number.isFinite(nextRefreshAt) && Date.now() > nextRefreshAt
        ? "stale"
        : this.snapshot.status;
    return { ...this.snapshot, status };
  }

  async refresh(
    recentCallLimit = this.config.monitor.recentCallLimit,
    priority: Sub2ApiReadPriority = "automatic",
  ): Promise<ScoreSnapshot> {
    if (this.inFlight) {
      await this.inFlight;
      return await this.state();
    }
    this.inFlight = this.performRefresh(recentCallLimit, priority);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
    return await this.state();
  }

  private async performRefresh(recentCallLimit: number, priority: Sub2ApiReadPriority): Promise<ScoreSnapshot> {
    const startedAt = new Date();
    this.snapshot = { ...this.snapshot, status: "refreshing", refreshStartedAt: startedAt.toISOString(), error: null };
    if (this.snapshotStore) await this.snapshotStore.beginSnapshotRefresh(scoreSnapshotKey, scoreCacheVersion, startedAt.toISOString());
    try {
      if (!this.reads) throw new Error("scores.refresh requires the Native API read executor");
      const collected = await collectRecentCallScoresFromDatabase(
        this.config,
        recentCallLimit,
        this.reads,
        null,
        null,
        priority,
      );
      const refreshedAt = new Date();
      const accounts = this.poolAccounts(mergeAccountScores(collected.accounts));
      const groupNames = [...new Set(accounts.flatMap((row) =>
        Array.isArray(row.groupNames) ? row.groupNames.map(String) : [],
      ))];
      this.snapshot = {
        cacheVersion: scoreCacheVersion,
        ok: true,
        status: "ready",
        refreshedAt: refreshedAt.toISOString(),
        refreshStartedAt: startedAt.toISOString(),
        nextRefreshAt: new Date(refreshedAt.getTime() + this.config.monitor.refreshIntervalMinutes * 60_000).toISOString(),
        window: `最近 ${recentCallLimit} 次`,
        recentCallLimit,
        groups: groupNames.map((name) => ({ name })),
        accounts,
        error: null,
        source: "postgresql-recent-account-calls",
        collection: {
          recentCallLimit,
          databaseQueries: collected.databaseQueries,
          queryDurationMs: collected.queryDurationMs,
        },
      };
      if (this.snapshotStore) await this.snapshotStore.completeSnapshot(scoreSnapshotKey, scoreCacheVersion, this.snapshot as unknown as Record<string, unknown>, refreshedAt.toISOString());
      else this.writeCache(this.snapshot);
      return this.snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.snapshotStore) {
        await this.snapshotStore.failSnapshotRefresh(scoreSnapshotKey, scoreCacheVersion, message);
        await this.readPersistentSnapshot();
      }
      this.snapshot = {
        ...this.snapshot,
        ok: this.snapshot.refreshedAt !== null,
        status: this.snapshot.refreshedAt === null ? "unavailable" : "stale",
        refreshStartedAt: startedAt.toISOString(),
        error: message,
      };
      if (!this.snapshotStore) this.writeCache(this.snapshot);
      return this.snapshot;
    }
  }

  private async readPersistentSnapshot(): Promise<void> {
    if (!this.snapshotStore) return;
    const row = await this.snapshotStore.getSnapshot(scoreSnapshotKey);
    const payload = record(row?.payload);
    if (payload && row?.schema_version === scoreCacheVersion && payload.cacheVersion === scoreCacheVersion) {
      const cached = payload as unknown as ScoreSnapshot;
      this.snapshot = {
        ...cached,
        recentCallLimit: typeof cached.recentCallLimit === "number" ? cached.recentCallLimit : this.config.monitor.recentCallLimit,
        status: row?.refresh_started_at ? "refreshing" : row?.last_error ? "stale" : cached.status,
        accounts: this.poolAccounts(mergeAccountScores(records(cached.accounts))),
        refreshStartedAt: row?.refresh_started_at ? String(row.refresh_started_at) : null,
        error: row?.last_error ? String(row.last_error) : null,
      };
      return;
    }
    if (row?.refresh_started_at || row?.last_error) {
      this.snapshot = {
        ...this.snapshot,
        status: row.refresh_started_at ? "refreshing" : "unavailable",
        refreshStartedAt: row.refresh_started_at ? String(row.refresh_started_at) : null,
        error: row.last_error ? String(row.last_error) : null,
      };
    }
  }

  private selectAccounts(
    accounts: Array<Record<string, unknown>>,
    accountSelector: string | null,
    groupSelector: string | null,
  ): Array<Record<string, unknown>> {
    const selected = accounts.filter((row) => {
      const accountMatch = accountSelector === null
        || String(row.accountId) === accountSelector
        || String(row.accountName) === accountSelector;
      const groupIds = Array.isArray(row.groupIds) ? row.groupIds.map(String) : [];
      const groupNames = Array.isArray(row.groupNames) ? row.groupNames.map(String) : [];
      const groupMatch = groupSelector === null || groupIds.includes(groupSelector) || groupNames.includes(groupSelector);
      return accountMatch && groupMatch;
    });
    if (accountSelector !== null && selected.length !== 1) {
      throw new Error(`account selector did not resolve exactly once: ${accountSelector}`);
    }
    if (groupSelector !== null && selected.length === 0) {
      throw new Error(`group selector resolved no scoreable accounts: ${groupSelector}`);
    }
    return selected;
  }

  private poolAccounts(accounts: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return accounts.filter((row) => {
      if (isOAuthAccount(row)) return false;
      const eligibleGroupIds = String(row.platform ?? "").toLowerCase() === "grok"
        ? this.config.sub2api.grokPriorityPlan.eligibleGroupIds
        : this.config.sub2api.priorityPlan.eligibleGroupIds;
      const groupIds = Array.isArray(row.groupIds) ? row.groupIds.map(Number) : [];
      return groupIds.some((id) => eligibleGroupIds.includes(id));
    });
  }

  private readCache(): ScoreSnapshot {
    if (existsSync(this.cachePath)) {
      try {
        const cached = record(JSON.parse(readFileSync(this.cachePath, "utf8"))) as ScoreSnapshot | null;
        if (cached && cached.cacheVersion === scoreCacheVersion) {
          return {
            ...cached,
            recentCallLimit: typeof cached.recentCallLimit === "number" ? cached.recentCallLimit : this.config.monitor.recentCallLimit,
            accounts: this.poolAccounts(mergeAccountScores(records(cached.accounts))),
          };
        }
      } catch {
        // Invalid cache is replaced by the next successful refresh.
      }
    }
    return {
      cacheVersion: scoreCacheVersion,
      ok: false,
      status: "unavailable",
      refreshedAt: null,
      refreshStartedAt: null,
      nextRefreshAt: null,
      window: `最近 ${this.config.monitor.recentCallLimit} 次`,
      recentCallLimit: this.config.monitor.recentCallLimit,
      groups: [],
      accounts: [],
      error: null,
      source: "sub2api-native-admin-api-local-aggregation",
    };
  }

  private writeCache(snapshot: ScoreSnapshot): void {
    mkdirSync(dirname(this.cachePath), { recursive: true });
    const next = `${this.cachePath}.next`;
    writeFileSync(next, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(next, this.cachePath);
  }
}
