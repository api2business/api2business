import { expect, test } from "bun:test";
import { apiCacheRefreshRequested, isApiResponseCacheable, readApiCache, refreshThenReadApiCache } from "./http";

const get = (pathname: string) => new Request(`https://api2business.example${pathname}`);

test("persistent snapshot APIs bypass the generic response cache", () => {
  for (const pathname of [
    "/api/upstreams/pool-quality",
    "/api/upstreams/pool-quality/errors?page=1",
    "/api/upstreams/quota-summary",
    "/api/upstreams/usage-cache?accountIds=1,2",
    "/api/upstreams/recharge-candidates",
    "/api/oauth/runtime-summary",
    "/api/admin/errors/diagnose?limit=1000",
    "/api/admin/errors/request-id",
    "/api/operations/priority-automation",
    "/api/operations/priority-history",
    "/api/operations/idle-probe/history?page=1",
    "/api/operations/idle-probe/summary",
  ]) {
    expect(isApiResponseCacheable(get(pathname))).toBeFalse();
  }
});

test("ordinary API reads keep the generic response cache", () => {
  expect(isApiResponseCacheable(get("/api/upstreams"))).toBeTrue();
  expect(isApiResponseCacheable(get("/api/operations/ledger"))).toBeTrue();
  expect(isApiResponseCacheable(get("/api/ranking"))).toBeTrue();
});

test("an ordinary API read returns the stored cache and does not refresh it", async () => {
  const stored = new Map<string, { status: number; headers: Record<string, string>; body: string; cached_at: string }>();
  stored.set("ranking", {
    status: 200,
    headers: { "content-type": "application/json" },
    body: "{\"ok\":true,\"ranking\":{\"queryCompletedAt\":\"old\"}}",
    cached_at: "old",
  });
  const response = await readApiCache("ranking", async (key) => stored.get(key) ?? null);
  expect(response.headers.get("x-api2business-cache")).toBe("hit");
  expect(await response.text()).toContain("old");
  expect(apiCacheRefreshRequested(new Request("https://api2business.example/api/ranking"))).toBeFalse();
  expect(apiCacheRefreshRequested(new Request("https://api2business.example/api/ranking", {
    headers: { "x-api2business-refresh": "1" },
  }))).toBeTrue();
});

test("a cache miss does not compute a live result", async () => {
  const response = await readApiCache("missing", async () => null);
  expect(response.headers.get("x-api2business-cache")).toBe("miss");
  expect(await response.json()).toMatchObject({ ok: false, error: "缓存尚未刷新" });
});

test("an explicit refresh writes the cache and returns that cache", async () => {
  const stored = new Map<string, { status: number; headers: Record<string, string>; body: string; cached_at: string }>();
  stored.set("ranking", {
    status: 200,
    headers: { "content-type": "application/json" },
    body: "{\"ok\":true,\"ranking\":{\"queryCompletedAt\":\"2026-09-23T01:18:06.000Z\"}}",
    cached_at: "2026-09-23T01:18:06.000Z",
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let refreshes = 0;
  const inflight = new Map();
  const pending = refreshThenReadApiCache(
    "ranking",
    inflight,
    async () => {
      refreshes += 1;
      await gate;
      return Response.json({ ok: true, ranking: { queryCompletedAt: "2026-09-23T03:40:00.000Z" } });
    },
    async (key) => stored.get(key) ?? null,
    async (key, status, headers, body) => {
      stored.set(key, { status, headers, body, cached_at: "2026-09-23T03:40:00.000Z" });
    },
  );
  const joined = refreshThenReadApiCache(
    "ranking",
    inflight,
    async () => {
      refreshes += 1;
      return Response.json({ ok: true, ranking: { queryCompletedAt: "other" } });
    },
    async (key) => stored.get(key) ?? null,
    async () => { throw new Error("second refresh must wait for the first write"); },
  );
  release();
  const [first, second] = await Promise.all([pending, joined]);
  expect(refreshes).toBe(1);
  expect(first.headers.get("x-api2business-cache")).toBe("refreshed");
  expect(await first.text()).toContain("2026-09-23T03:40:00.000Z");
  expect(await second.text()).toContain("2026-09-23T03:40:00.000Z");
  expect(stored.get("ranking")?.body).toContain("2026-09-23T03:40:00.000Z");
});

test("a failed cache refresh returns the error and keeps the previous cache", async () => {
  const stored = new Map<string, { status: number; headers: Record<string, string>; body: string; cached_at: string }>();
  stored.set("ranking", {
    status: 200,
    headers: {},
    body: "{\"ok\":true,\"ranking\":{\"queryCompletedAt\":\"old\"}}",
    cached_at: "old",
  });
  const response = await refreshThenReadApiCache(
    "ranking",
    new Map(),
    async () => Response.json({ ok: false, error: "查询失败" }, { status: 500 }),
    async (key) => stored.get(key) ?? null,
    async () => { throw new Error("failed refresh must not replace the cache"); },
  );
  expect(response.status).toBe(500);
  expect(await response.text()).toContain("查询失败");
  expect(stored.get("ranking")?.body).toContain("old");
});
