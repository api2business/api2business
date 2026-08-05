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
