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
    requests.push(String(input));
    return new Response(JSON.stringify({
      mode: "limited",
      quota: { limit: 100, used: 40, remaining: 60, unit: "USD" },
      usage: { input_tokens: 10, output_tokens: 5, actual_cost: 2.5, request_count: 3 },
    }), { status: 200 });
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 30 });
  expect(requests).toEqual(["https://api.example.com/v1/usage?days=30"]);
  expect(result.provider).toBe("sub2api");
  expect(result.quota.remaining).toBe(60);
  expect(result.usage.totalTokens).toBe(15);
});

test("falls back to New API and marks recent-log token usage incomplete", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/v1/usage?days=7")) return new Response("not found", { status: 404 });
    if (url.endsWith("/api/usage/token/")) {
      return new Response(JSON.stringify({ data: { total_granted: 1000, total_used: 250, total_available: 750, unlimited_quota: false } }));
    }
    return new Response(JSON.stringify({ data: [{ prompt_tokens: 11, completion_tokens: 4 }, { prompt_tokens: 5, completion_tokens: 2 }] }));
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 7 });
  expect(requests).toEqual([
    "https://api.example.com/v1/usage?days=7",
    "https://api.example.com/api/usage/token/",
    "https://api.example.com/api/log/token",
  ]);
  expect(result.provider).toBe("new-api");
  expect(result.quota.remaining).toBe(750);
  expect(result.usage.totalTokens).toBe(22);
  expect(result.window.complete).toBe(false);
  expect(result.warning).toContain("仅覆盖最近日志");
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
    return new Response(JSON.stringify({ data: [] }));
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 30 });
  expect(requests).toContain("https://api.example.com/api/usage/token/");
  expect(result.provider).toBe("new-api");
  expect(result.quota.remaining).toBe(120);
});

test("parses current Sub2API unrestricted wallet and nested total usage", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
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
  globalThis.fetch = (async () => new Response(JSON.stringify({
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
