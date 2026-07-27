import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mergeAccountScores } from "./account-score-aggregation";
import { collectRecentCallScoresFromDatabase } from "./account-score-database";
import type { AppConfig } from "./config";
import type { Sub2ApiClient } from "./sub2api-client";
import type { RuntimePolicyEventSource } from "./runtime-policy-events";

interface ScoreSnapshot {
  ok: boolean;
  status: "ready" | "refreshing" | "stale" | "unavailable";
  refreshedAt: string | null;
  refreshStartedAt: string | null;
  nextRefreshAt: string | null;
  window: string;
  groups: Array<Record<string, unknown>>;
  accounts: Array<Record<string, unknown>>;
  error: string | null;
  source: string;
  collection?: Record<string, unknown>;
}

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
    private readonly policyEvents: RuntimePolicyEventSource,
    private readonly scoreDatabaseUrl: string | null = null,
  ) {
    this.snapshot = this.readCache();
  }

  async rank(recentCallLimit: number, accountSelector: string | null = null, groupSelector: string | null = null): Promise<Record<string, unknown>> {
    if (!this.config.monitor.recentCallOptions.includes(recentCallLimit)) {
      throw new Error(`recentCallLimit must be one of: ${this.config.monitor.recentCallOptions.join(", ")}`);
    }
    const result = await collectRecentCallScoresFromDatabase(
      this.config,
      recentCallLimit,
      accountSelector,
      groupSelector,
      this.scoreDatabaseUrl,
    );
    const groupNames = [...new Set(result.accounts.flatMap((row) =>
      Array.isArray(row.groupNames) ? row.groupNames.map(String) : [],
    ))];
    return {
      ...result,
      status: "ready",
      refreshedAt: new Date().toISOString(),
      nextRefreshAt: null,
      window: `最近 ${recentCallLimit} 次`,
      groups: groupNames.map((name) => ({ name })),
      availableCallOptions: this.config.monitor.recentCallOptions,
    };
  }

  start(): void {
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.config.monitor.refreshIntervalMinutes * 60_000);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  state(): ScoreSnapshot {
    if (!this.inFlight && existsSync(this.cachePath)) this.snapshot = this.readCache();
    const nextRefreshAt = this.snapshot.nextRefreshAt ? Date.parse(this.snapshot.nextRefreshAt) : Number.NaN;
    const status = this.inFlight
      ? "refreshing"
      : this.snapshot.status === "ready" && Number.isFinite(nextRefreshAt) && Date.now() > nextRefreshAt
        ? "stale"
        : this.snapshot.status;
    return { ...this.snapshot, status };
  }

  async refresh(): Promise<ScoreSnapshot> {
    if (this.inFlight) return await this.inFlight;
    this.inFlight = this.performRefresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async performRefresh(): Promise<ScoreSnapshot> {
    const startedAt = new Date();
    this.snapshot = { ...this.snapshot, status: "refreshing", refreshStartedAt: startedAt.toISOString(), error: null };
    try {
      const collected = await collectRecentCallScoresFromDatabase(
        this.config,
        this.config.monitor.recentCallLimit,
        null,
        null,
        this.scoreDatabaseUrl,
      );
      const refreshedAt = new Date();
      const accounts = mergeAccountScores(collected.accounts);
      const groupNames = [...new Set(accounts.flatMap((row) =>
        Array.isArray(row.groupNames) ? row.groupNames.map(String) : [],
      ))];
      this.snapshot = {
        ok: true,
        status: "ready",
        refreshedAt: refreshedAt.toISOString(),
        refreshStartedAt: startedAt.toISOString(),
        nextRefreshAt: new Date(refreshedAt.getTime() + this.config.monitor.refreshIntervalMinutes * 60_000).toISOString(),
        window: `最近 ${this.config.monitor.recentCallLimit} 次`,
        groups: groupNames.map((name) => ({ name })),
        accounts,
        error: null,
        source: "postgresql-recent-account-calls",
        collection: {
          recentCallLimit: this.config.monitor.recentCallLimit,
          databaseQueries: collected.databaseQueries,
          queryDurationMs: collected.queryDurationMs,
        },
      };
      this.writeCache(this.snapshot);
      return this.snapshot;
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        ok: this.snapshot.refreshedAt !== null,
        status: this.snapshot.refreshedAt === null ? "unavailable" : "stale",
        refreshStartedAt: startedAt.toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      this.writeCache(this.snapshot);
      return this.snapshot;
    }
  }

  private readCache(): ScoreSnapshot {
    if (existsSync(this.cachePath)) {
      try {
        const cached = record(JSON.parse(readFileSync(this.cachePath, "utf8"))) as ScoreSnapshot | null;
        if (cached) return { ...cached, accounts: mergeAccountScores(records(cached.accounts)) };
      } catch {
        // Invalid cache is replaced by the next successful refresh.
      }
    }
    return {
      ok: false,
      status: "unavailable",
      refreshedAt: null,
      refreshStartedAt: null,
      nextRefreshAt: null,
      window: `最近 ${this.config.monitor.recentCallLimit} 次`,
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
