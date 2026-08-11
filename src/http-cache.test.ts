import { expect, test } from "bun:test";
import { isApiResponseCacheable } from "./http";

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
});
