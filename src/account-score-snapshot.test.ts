import { expect, test } from "bun:test";
import { AccountScoreService, type ScoreSnapshotStore } from "./account-score-service";

function fixture(status: "ready" | "refreshing" | "stale") {
  const row: Record<string, unknown> = {
    schema_version: "api-key-only-v1",
    payload: {
      cacheVersion: "api-key-only-v1",
      ok: true,
      status: "ready",
      refreshedAt: "2026-08-05T01:00:00.000Z",
      refreshStartedAt: null,
      nextRefreshAt: "2099-08-05T01:05:00.000Z",
      window: "最近 1,000 次",
      groups: [],
      accounts: [],
      error: null,
      source: "postgresql-recent-account-calls",
    },
    refresh_started_at: status === "refreshing" ? "2026-08-05T01:04:00.000Z" : null,
    last_error: status === "stale" ? "temporary query failure" : null,
  };
  const store = {
    async getSnapshot() { return row; },
    async beginSnapshotRefresh() {},
    async completeSnapshot() {},
    async failSnapshotRefresh() {},
  } satisfies ScoreSnapshotStore;
  const config = { monitor: { recentCallLimit: 1000 } } as never;
  return new AccountScoreService(config, "/tmp/api2business-unused-score-cache.json", {} as never, null, store);
}

test("shared PostgreSQL score snapshot survives process-local empty state", async () => {
  const state = await fixture("ready").state();
  expect(state).toMatchObject({ ok: true, status: "ready", refreshedAt: "2026-08-05T01:00:00.000Z" });
});

test("shared score snapshot exposes refresh without clearing the successful payload", async () => {
  const state = await fixture("refreshing").state();
  expect(state).toMatchObject({ ok: true, status: "refreshing", refreshedAt: "2026-08-05T01:00:00.000Z" });
});

test("shared score snapshot keeps the last success after a failed refresh", async () => {
  const state = await fixture("stale").state();
  expect(state).toMatchObject({ ok: true, status: "stale", refreshedAt: "2026-08-05T01:00:00.000Z", error: "temporary query failure" });
});

test("rank refreshes the shared snapshot and both reads return the policy score", async () => {
  const policy = {
    reliabilityWeight: 48,
    failoverWeight: 10,
    latencyWeight: 37,
    baselineWeight: 5,
    failureZeroScoreRate: 0.2,
    failureBurstCallLimit: 100,
    failoverZeroScoreRate: 0.2,
    ttftFullScoreMs: 5_000,
    ttftZeroScoreMs: 55_000,
    ttftPriorScore: 25,
  };
  const plan = { eligibleGroupIds: [2], procurementAdvice: { billingErrorPatterns: [] } };
  const config = {
    monitor: { recentCallLimit: 1000, recentCallOptions: [500, 1000], refreshIntervalMinutes: 5 },
    sub2api: {
      scorePolicy: policy,
      grokScorePolicy: policy,
      scoreSamplePolicy: { retentionHours: 8, decayBucketSize: 100, decayStep: 0.1, minimumWeight: 0.1 },
      priorityPlan: plan,
      grokPriorityPlan: plan,
    },
  };
  let stored: Record<string, unknown> | null = null;
  let queriedLimit = 0;
  let queries = 0;
  const store = {
    async getSnapshot() { return stored; },
    async beginSnapshotRefresh() {},
    async completeSnapshot(_key: string, _schema: string, payload: Record<string, unknown>) { stored = { schema_version: "api-key-only-v1", payload, refresh_started_at: null, last_error: null }; },
    async failSnapshotRefresh() {},
  } satisfies ScoreSnapshotStore;
  const reads = {
    async query(input: { parameters: unknown[] }) {
      queries += 1;
      queriedLimit = Number(input.parameters[0]);
      return {
        rows: [{
          account_id: 478,
          account_name: "https://rapidapi.cc pro",
          platform: "openai",
          account_type: "apikey",
          status: "active",
          schedulable: true,
          priority: 195,
          group_ids: [2],
          group_names: ["自用"],
          success_requests: 51,
          failure_requests: 0,
          attributed_requests: 51,
          failover_requests: 0,
          first_token_samples: 0,
          selected_calls: 51,
        }],
        cached: false,
        queueDurationMs: 1,
        queryDurationMs: 2,
        queryStartedAt: "2026-09-23T03:00:00.000Z",
        queryCompletedAt: "2026-09-23T03:00:01.000Z",
        deduplicated: true,
      };
    },
  };
  const service = new AccountScoreService(config as never, "/tmp/api2business-unused-score-cache.json", {} as never, reads as never, store);
  const ranked = await service.rank(1000, null, null);
  const snapshot = await service.state();
  expect(queriedLimit).toBe(1000);
  expect(ranked.recentCallLimit).toBe(1000);
  expect((ranked.accounts as Array<Record<string, unknown>>)[0]?.score).toBe(72.3);
  expect(snapshot.accounts[0]?.score).toBe(72.3);
  expect(snapshot.accounts[0]?.score).toBe((ranked.accounts as Array<Record<string, unknown>>)[0]?.score);
  const latest = await service.readLatest();
  expect(queries).toBe(1);
  expect(queriedLimit).toBe(1000);
  expect(latest.accounts[0]?.score).toBe(72.3);
  expect(latest.accounts[0]?.score).toBe(snapshot.accounts[0]?.score);
});
