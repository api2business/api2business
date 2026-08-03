import { afterEach, expect, test } from "bun:test";
import { queryUpstreamUsage, queryUpstreamUsageConcurrently } from "./upstream-usage";

const originalFetch = globalThis.fetch;
const target = {
  id: 12,
  name: "https://api.example.com plus 0.05",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test-secret-value",
};

afterEach(() => { globalThis.fetch = originalFetch; });

test("queries Sub2API usage from the control origin and parses quota", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/v1/sub2api/billing")) {
      return new Response(JSON.stringify({
        object: "sub2api.key_billing",
        schema_version: 1,
        effective_rate_multiplier: 0.12,
        group_rate_multiplier: 0.1,
        user_rate_multiplier: 0.12,
        peak_rate_enabled: false,
        observed_at: "2026-08-01T12:00:00Z",
      }));
    }
    return new Response(JSON.stringify({
      mode: "limited",
      quota: { limit: 100, used: 40, remaining: 60, unit: "USD" },
      usage: { input_tokens: 10, output_tokens: 5, actual_cost: 2.5, request_count: 3 },
    }), { status: 200 });
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 30 });
  expect(requests).toEqual([
    "https://api.example.com/v1/usage?days=30",
    "https://api.example.com/v1/sub2api/billing",
  ]);
  expect(result.provider).toBe("sub2api");
  expect(result.quota.remaining).toBe(60);
  expect(result.usage.totalTokens).toBe(15);
  expect(result.billingMultiplier).toEqual({
    value: 0.12,
    source: "sub2api-live",
    scope: "effective",
    observedAt: "2026-08-01T12:00:00Z",
    group: 0.1,
    user: 0.12,
    peak: null,
  });
});

test("rejects a zero Sub2API billing multiplier as missing evidence", async () => {
  globalThis.fetch = (async (input) => new Response(JSON.stringify(String(input).endsWith("/v1/sub2api/billing") ? {
    object: "sub2api.key_billing",
    schema_version: 1,
    effective_rate_multiplier: 0,
  } : {
    mode: "limited",
    quota: { remaining: 10 },
  }))) as unknown as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 30 });
  expect(result.provider).toBe("sub2api");
  expect(result.billingMultiplier.value).toBeNull();
});

test("does not misreport a finite New API key quota as account balance", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/v1/usage?days=7")) return new Response("not found", { status: 404 });
    if (url.endsWith("/api/usage/token/")) {
      return new Response(JSON.stringify({ data: { total_granted: 1000, total_used: 250, total_available: 750, unlimited_quota: false } }));
    }
    if (url.endsWith("/api/status")) return new Response(JSON.stringify({ data: { quota_per_unit: 500 } }));
    if (url.includes("/dashboard/billing/")) return new Response(JSON.stringify({ hard_limit_usd: 2, total_usage: 50 }));
    return new Response(JSON.stringify({ data: [
      { prompt_tokens: 11, completion_tokens: 4, created_at: 1785585600, other: JSON.stringify({ group_ratio: 0.2, user_group_ratio: 0.15 }) },
      { prompt_tokens: 5, completion_tokens: 2, other: JSON.stringify({ group_ratio: 0.2 }) },
    ] }));
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 7 });
  expect(requests).toEqual([
    "https://api.example.com/v1/usage?days=7",
    "https://api.example.com/api/usage/token/",
    "https://api.example.com/api/status",
    "https://api.example.com/dashboard/billing/subscription",
    "https://api.example.com/dashboard/billing/usage",
    "https://api.example.com/api/log/token",
  ]);
  expect(result.provider).toBe("new-api");
  expect(result.quota.remaining).toBeNull();
  expect(result.quota.unit).toBeNull();
  expect(result.warning).toContain("API Key 配额");
  expect(result.usage.totalTokens).toBe(22);
  expect(result.window.complete).toBe(false);
  expect(result.warning).toContain("仅覆盖最近日志");
  expect(result.billingMultiplier.value).toBe(0.15);
  expect(result.billingMultiplier.source).toBe("new-api-log");
  expect(result.billingMultiplier.scope).toBe("user-group");
});

test("falls back to a positive New API group ratio when the user ratio is zero", async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/usage?days=7")) return new Response("not found", { status: 404 });
    if (url.endsWith("/api/usage/token/")) return new Response(JSON.stringify({
      data: { total_available: 1, unlimited_quota: false },
    }));
    if (url.includes("/api/log/token")) return new Response(JSON.stringify({ data: [
      { other: JSON.stringify({ user_group_ratio: 0, group_ratio: 0.08 }) },
    ] }));
    return new Response(JSON.stringify({ data: {} }));
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 7 });
  expect(result.billingMultiplier.value).toBe(0.08);
  expect(result.billingMultiplier.scope).toBe("group");
});

test("keeps the New API billing multiplier unknown when all observed ratios are zero", async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/usage?days=7")) return new Response("not found", { status: 404 });
    if (url.endsWith("/api/usage/token/")) return new Response(JSON.stringify({
      data: { total_available: 1, unlimited_quota: false },
    }));
    if (url.includes("/api/log/token")) return new Response(JSON.stringify({ data: [
      { other: JSON.stringify({ user_group_ratio: 0, group_ratio: 0 }) },
    ] }));
    return new Response(JSON.stringify({ data: {} }));
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 7 });
  expect(result.billingMultiplier.value).toBeNull();
});

test("does not treat a fieldless unrestricted response as usage data", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/v1/usage?days=30")) return new Response(JSON.stringify({ mode: "unrestricted" }));
    if (url.endsWith("/api/usage/token/")) {
      return new Response(JSON.stringify({ data: { total_granted: 200, total_used: 80, total_available: 120, unlimited_quota: false } }));
    }
    if (url.endsWith("/api/status")) return new Response(JSON.stringify({ data: { quota_per_unit: 100 } }));
    if (url.includes("/dashboard/billing/")) return new Response(JSON.stringify({ hard_limit_usd: 2, total_usage: 80 }));
    return new Response(JSON.stringify({ data: [] }));
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 30 });
  expect(requests).toContain("https://api.example.com/api/usage/token/");
  expect(result.provider).toBe("new-api");
  expect(result.quota.remaining).toBeNull();
});

test("queries account billing for an unlimited New API token", async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/usage?days=30")) return new Response("not found", { status: 404 });
    if (url.endsWith("/api/usage/token/")) {
      return new Response(JSON.stringify({ data: { total_granted: 0, total_used: 10_000, total_available: -10_000, unlimited_quota: true } }));
    }
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({ data: { quota_per_unit: 500_000, quota_display_type: "USD" } }));
    }
    if (url.endsWith("/dashboard/billing/subscription")) {
      return new Response(JSON.stringify({ hard_limit_usd: 20 }));
    }
    if (url.endsWith("/dashboard/billing/usage")) {
      return new Response(JSON.stringify({ total_usage: 450 }));
    }
    return new Response(JSON.stringify({ data: [] }));
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 30 });
  expect(result.quota).toEqual({ limit: 20, used: 4.5, remaining: 15.5, unlimited: true, unit: "USD" });
  expect(result.warning).toContain("账号级证据");
});

test("parses current Sub2API unrestricted wallet and nested total usage", async () => {
  globalThis.fetch = (async (input) => new Response(JSON.stringify(String(input).endsWith("/v1/sub2api/billing") ? {} : {
    mode: "unrestricted",
    planName: "钱包余额",
    remaining: 88.5,
    balance: 88.5,
    unit: "USD",
    usage: { total: { requests: 9, input_tokens: 100, output_tokens: 25, actual_cost: 4.2 } },
  }))) as unknown as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 30 });
  expect(result.provider).toBe("sub2api");
  expect(result.quota.remaining).toBe(88.5);
  expect(result.quota.unlimited).toBe(false);
  expect(result.usage.requestCount).toBe(9);
  expect(result.usage.totalTokens).toBe(125);
  expect(result.usage.actualCostUsd).toBe(4.2);
});

test("parses current Sub2API subscription windows", async () => {
  globalThis.fetch = (async (input) => new Response(JSON.stringify(String(input).endsWith("/v1/sub2api/billing") ? {} : {
    mode: "unrestricted",
    remaining: 70,
    unit: "USD",
    subscription: { monthly_limit_usd: 100, monthly_usage_usd: 30 },
  }))) as unknown as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 30 });
  expect(result.quota).toEqual({ limit: 100, used: 30, remaining: 70, unlimited: false, unit: "USD" });
});

test("redacts API keys from upstream failures", async () => {
  globalThis.fetch = (async () => { throw new Error("failed with sk-live-secret-value"); }) as unknown as typeof fetch;
  const result = await queryUpstreamUsage(target, { timeoutMs: 20, days: 30 });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("[REDACTED]");
  expect(result.error).not.toContain("sk-live-secret-value");
});

test("returns visible timeout failures", async () => {
  globalThis.fetch = ((_, init) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  })) as typeof fetch;
  const result = await queryUpstreamUsage(target, { timeoutMs: 5, days: 30 });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/timed out|timeout|aborted/iu);
});

test("bounds concurrent upstream requests", async () => {
  let active = 0;
  let maximum = 0;
  globalThis.fetch = (async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return new Response(JSON.stringify({ mode: "unrestricted", usage: { total_tokens: 1 } }));
  }) as unknown as typeof fetch;

  const results = await queryUpstreamUsageConcurrently(
    Array.from({ length: 7 }, (_, index) => ({ ...target, id: index + 1 })),
    { timeoutMs: 100, days: 30, concurrency: 3 },
  );
  expect(results).toHaveLength(7);
  expect(maximum).toBe(3);
});
