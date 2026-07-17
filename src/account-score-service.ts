import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mergeAccountScores } from "./account-score-aggregation";
import type { AppConfig } from "./config";

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
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function nested(root: unknown, ...keys: string[]): unknown {
  let value = root;
  for (const key of keys) value = record(value)?.[key];
  return value;
}

async function pooled<T, R>(values: T[], concurrency: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await operation(values[index]!);
    }
  }));
  return results;
}

export class AccountScoreService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<ScoreSnapshot> | null = null;
  private snapshot: ScoreSnapshot;

  constructor(private readonly config: AppConfig, private readonly cachePath: string, private readonly cliWorkDir: string) {
    this.snapshot = this.readCache();
  }

  start(): void {
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.config.monitor.refreshIntervalMinutes * 60_000);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  state(): ScoreSnapshot {
    return { ...this.snapshot, status: this.inFlight ? "refreshing" : this.snapshot.status };
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
      const overview = await this.invoke(["--all-groups"]);
      const groups = records(nested(overview, "data", "parsed", "allGroups", "groups"));
      const details = await pooled(groups, 2, async (group) => {
        const id = String(group.groupId ?? "");
        if (!id) return { group, accounts: [] as Array<Record<string, unknown>> };
        const payload = await this.invoke(["--group", id]);
        return {
          group,
          accounts: records(nested(payload, "data", "parsed", "errors", "nativeOps", "accountQuality", "accounts")),
        };
      });
      const refreshedAt = new Date();
      const accounts = mergeAccountScores(details.flatMap(({ group, accounts }) => accounts.map((account): Record<string, unknown> => ({
        groupId: group.groupId ?? null,
        groupName: group.groupName ?? null,
        platform: group.platform ?? null,
        ...account,
      }))));
      this.snapshot = {
        ok: true,
        status: "ready",
        refreshedAt: refreshedAt.toISOString(),
        refreshStartedAt: startedAt.toISOString(),
        nextRefreshAt: new Date(refreshedAt.getTime() + this.config.monitor.refreshIntervalMinutes * 60_000).toISOString(),
        window: this.config.monitor.scoreWindow,
        groups,
        accounts,
        error: null,
        source: "unidesk-sub2api-runtime-errors",
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
      return this.snapshot;
    }
  }

  private async invoke(scope: string[]): Promise<Record<string, unknown>> {
    const args = [
      resolve(this.cliWorkDir, this.config.monitor.cli.entrypoint),
      "platform-infra", "sub2api", "codex-pool", "runtime", "errors",
      "--target", this.config.monitor.target,
      "--since", this.config.monitor.scoreWindow,
      ...scope,
      "--raw",
    ];
    const process = Bun.spawn([this.config.monitor.cli.executable, ...args], {
      cwd: this.cliWorkDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, UNIDESK_MAIN_SERVER_IP: this.config.monitor.cli.mainServerHost },
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, this.config.monitor.cli.timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]).finally(() => clearTimeout(timeout));
    if (timedOut) throw new Error(`评分 CLI 在 ${this.config.monitor.cli.timeoutMs}ms 后超时`);
    if (exitCode !== 0) throw new Error(`评分 CLI 退出码 ${exitCode}: ${stderr.trim().slice(-600)}`);
    let payload = record(JSON.parse(stdout));
    if (!payload || payload.ok !== true) throw new Error("评分 CLI 返回无效结果");
    if (nested(payload, "data", "outputTruncated")) {
      const dumpPath = nested(payload, "data", "dump", "path");
      if (typeof dumpPath !== "string" || !dumpPath.startsWith("/tmp/unidesk-cli-output/")) {
        throw new Error("评分 CLI 渐进披露结果缺少受保护 dump");
      }
      try {
        payload = record(JSON.parse(readFileSync(dumpPath, "utf8")));
      } finally {
        try { unlinkSync(dumpPath); } catch { /* The CLI may clean up its own temporary output. */ }
      }
      if (!payload || payload.ok !== true) throw new Error("评分 CLI dump 返回无效结果");
    }
    return payload;
  }

  private readCache(): ScoreSnapshot {
    if (existsSync(this.cachePath)) {
      try {
        const cached = record(JSON.parse(readFileSync(this.cachePath, "utf8"))) as ScoreSnapshot | null;
        if (cached) return { ...cached, status: "stale", accounts: mergeAccountScores(records(cached.accounts)) };
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
      window: this.config.monitor.scoreWindow,
      groups: [],
      accounts: [],
      error: null,
      source: "unidesk-sub2api-runtime-errors",
    };
  }

  private writeCache(snapshot: ScoreSnapshot): void {
    mkdirSync(dirname(this.cachePath), { recursive: true });
    const next = `${this.cachePath}.next`;
    writeFileSync(next, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(next, this.cachePath);
  }
}
