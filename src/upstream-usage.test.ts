import { afterEach, expect, test } from "bun:test";
import {
  queryUpstreamUsage,
  queryUpstreamUsageConcurrently,
  summarizeQuotaProviderCoverage,
  summarizeQuotaWindowCoverage,
  type QuotaWindowObservation,
  type UpstreamUsageResult,
} from "./upstream-usage";

const originalFetch = globalThis.fetch;
const target = {
  id: 12,
  name: "https://api.example.com plus 0.05",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test-secret-value",
};

afterEach(() => { globalThis.fetch = originalFetch; });

function quotaWindow(window: QuotaWindowObservation["window"], remainingPercent: number): QuotaWindowObservation {
  return {
    window,
    limit: 100,
    used: 100 - remainingPercent,
    remaining: remainingPercent,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    unit: "USD",
    resetAt: null,
    observedAt: "2026-11-08T06:00:00.000Z",
    source: "test",
    status: "ok",
    complete: true,
    missingReason: null,
  };
}

function coverageResult(
  accountId: number,
  provider: UpstreamUsageResult["provider"],
  baseUrl: string,
  windows: QuotaWindowObservation[],
): UpstreamUsageResult {
  return {
    accountId,
    accountName: String(accountId),
    baseUrl,
    walletKey: baseUrl,
    status: "active",
    schedulable: true,
    apiAmountUsdTotal: 0,
    ok: windows.length > 0,
    provider,
    quota: { limit: null, used: null, remaining: null, unlimited: null, unit: null },
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, actualCostUsd: null, requestCount: null },
    quotaWindows: windows,
    lowQuotaWarnings: windows
      .filter((item) => item.remainingPercent !== null && item.remainingPercent <= 20)
      .map((item) => ({ window: item.window, remainingPercent: item.remainingPercent!, resetAt: null, thresholdPercent: 20 })),
    billingMultiplier: { value: null, source: null, scope: null, observedAt: null, group: null, user: null, peak: null },
    window: { days: 1, records: null, complete: windows.length > 0 },
    queriedAt: "2026-11-08T06:00:00.000Z",
    durationMs: 1,
    warning: null,
    error: windows.length > 0 ? null : "quota endpoint denied",
  };
}

test("summarizes the three quota windows without inferring unknown windows", () => {
  const coverage = summarizeQuotaWindowCoverage([
    coverageResult(1, "opencode-go", "https://opencode.ai/zen/go/v1", [
      quotaWindow("five_hour", 100), quotaWindow("weekly", 0),
    ]),
    coverageResult(2, "command-code", "https://api.commandcode.ai/provider/v1", []),
    coverageResult(3, "unknown", "https://unrelated.example.com/v1", [quotaWindow("weekly", 5)]),
  ]);
  expect(coverage).toEqual([
    { window: "five_hour", accounts: 2, observed: 1, unknown: 1, lowQuotaWarnings: 0 },
    { window: "weekly", accounts: 2, observed: 1, unknown: 1, lowQuotaWarnings: 1 },
    { window: "monthly", accounts: 2, observed: 0, unknown: 2, lowQuotaWarnings: 0 },
  ]);
});

test("summarizes OpenCode and CommandCode coverage including failed accounts inferred from exact endpoints", () => {
  const openCodeTarget = "https://opencode.ai/zen/go/v1";
  const commandCodeTarget = "https://api.commandcode.ai/provider/v1";
  const coverage = summarizeQuotaProviderCoverage([
    coverageResult(1, "opencode-go", openCodeTarget, [
      quotaWindow("five_hour", 100), quotaWindow("weekly", 0), quotaWindow("monthly", 15),
    ]),
    coverageResult(2, "unknown", openCodeTarget, []),
    coverageResult(3, "command-code", commandCodeTarget, [
      quotaWindow("five_hour", 81), quotaWindow("weekly", 56), quotaWindow("monthly", 50),
    ]),
    coverageResult(4, "unknown", "https://unrelated.example.com/v1", []),
  ]);

  expect(coverage).toEqual([
    {
      provider: "opencode-go",
      accountCount: 2,
      succeeded: 1,
      failed: 1,
      windows: [
        { window: "five_hour", observed: 1, unknown: 1, lowQuotaWarnings: 0 },
        { window: "weekly", observed: 1, unknown: 1, lowQuotaWarnings: 1 },
        { window: "monthly", observed: 1, unknown: 1, lowQuotaWarnings: 1 },
      ],
    },
    {
      provider: "command-code",
      accountCount: 1,
      succeeded: 1,
      failed: 0,
      windows: [
        { window: "five_hour", observed: 1, unknown: 0, lowQuotaWarnings: 0 },
        { window: "weekly", observed: 1, unknown: 0, lowQuotaWarnings: 0 },
        { window: "monthly", observed: 1, unknown: 0, lowQuotaWarnings: 0 },
      ],
    },
  ]);
});

test("queries Sub2API usage from the control origin and parses quota", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
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
  globalThis.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith("/v1/sub2api/billing") ? {
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
  globalThis.fetch = (async (input: RequestInfo | URL) => {
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

test("uses New API token user_quota as the whole account remaining balance", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/v1/usage?days=7")) return new Response("not found", { status: 404 });
    if (url.endsWith("/api/usage/token/")) {
      return new Response(JSON.stringify({ data: {
        total_granted: 100,
        total_used: 20,
        total_available: 80,
        unlimited_quota: true,
        user_quota: { total_available: 4_500_000, total_used: 1_500_000 },
      } }));
    }
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({ data: { quota_per_unit: 500_000, quota_display_type: "USD" } }));
    }
    if (url.endsWith("/api/log/token")) return new Response(JSON.stringify({ data: [] }));
    if (url.includes("/dashboard/billing/")) throw new Error("dashboard billing must not be queried");
    return new Response(JSON.stringify({ data: {} }));
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 7 });
  expect(requests).not.toContain("https://api.example.com/dashboard/billing/subscription");
  expect(result.provider).toBe("new-api");
  expect(result.quota).toEqual({ limit: 12, used: 3, remaining: 9, unlimited: false, unit: "USD" });
  expect(result.warning).toContain("user_quota");
});

test("one shared wallet fact per round preserves each Sub2API key's usage and billing", async () => {
  let round = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const second = new Headers(init?.headers).get("authorization") === "Bearer key-two";
    if (String(input).includes("/v1/usage?")) return Response.json({ mode: "unrestricted",
      balance: 50 - round - (second ? 1 : 0), unit: "USD",
      usage: { total: { total_tokens: second ? 200 : 100, actual_cost: second ? 4 : 2 } } });
    return Response.json({ object: "sub2api.key_billing", schema_version: 1, effective_rate_multiplier: second ? 0.2 : 0.1 });
  }) as typeof fetch;
  const targets = [target, { ...target, id: 13, apiKey: "key-two" }];
  for (round = 0; round < 2; round++) {
    const results = await queryUpstreamUsageConcurrently(targets, { timeoutMs: 100, days: 7, concurrency: 1 });
    expect(results.map(item => item.quota.remaining)).toEqual([50 - round, 50 - round]);
    expect(results.map(item => item.usage.totalTokens)).toEqual([100, 200]);
    expect(results.map(item => item.billingMultiplier.value)).toEqual([0.1, 0.2]);
    expect(results[0]!.walletBalance).toEqual(results[1]!.walletBalance);
    expect(results[0]!.walletBalance?.sourceAccountId).toBe(12);
  }
});

test("Sub2API key quotas cannot become shared wallet balances", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => Response.json(String(input).includes("/v1/usage?")
    ? { mode: "quota_limited", quota: { remaining: 0, unit: "USD" }, usage: { total: { total_tokens: 17 } } }
    : {})) as typeof fetch;
  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 7 });
  expect(result.ok).toBeTrue();
  expect(result.quota.remaining).toBeNull();
  expect(result.quota.unit).toBeNull();
  expect(result.usage.totalTokens).toBe(17);
  expect(result.warning).toContain("只返回 API Key 配额");
});

test("uses API Key requests only and never attempts New API login", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/v1/usage?days=7")) return new Response("not found", { status: 404 });
    if (url.endsWith("/api/usage/token/")) return new Response(JSON.stringify({ data: {
      total_available: 100, total_used: 20, unlimited_quota: false,
      user_quota: { total_available: 4_500_000, total_used: 1_500_000 },
    } }));
    if (url.endsWith("/api/status")) return new Response(JSON.stringify({ data: { quota_per_unit: 500_000 } }));
    if (url.endsWith("/api/log/token")) return new Response(JSON.stringify({ data: [] }));
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 7 });
  expect(result.provider).toBe("new-api");
  expect(result.quota).toEqual({ limit: 12, used: 3, remaining: 9, unlimited: false, unit: "USD" });
  expect(requests.some((request) => request.includes("/api/user/login"))).toBeFalse();
  expect(requests.some((request) => request.includes("/api/user/self"))).toBeFalse();
});

test("falls back to a positive New API group ratio when the user ratio is zero", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
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

test("accepts forked New API log containers and nested billing metadata", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/usage?days=7")) return new Response("not found", { status: 404 });
    if (url.endsWith("/api/usage/token/")) return new Response(JSON.stringify({
      data: { total_available: 1, unlimited_quota: false },
    }));
    if (url.includes("/api/log/token")) return new Response(JSON.stringify({ data: {
      rows: [{
        prompt_tokens: 3,
        completion_tokens: 2,
        createdAt: 1785585600123,
        other: JSON.stringify({ billing: { userGroupRatio: 0.23, groupRatio: 0.19 } }),
      }],
    } }));
    return new Response(JSON.stringify({ data: {} }));
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 7 });
  expect(result.billingMultiplier.value).toBe(0.23);
  expect(result.billingMultiplier.scope).toBe("user-group");
  expect(result.billingMultiplier.group).toBe(0.19);
  expect(result.billingMultiplier.observedAt).toBe("2026-08-01T12:00:00.123Z");
  expect(result.usage.totalTokens).toBe(5);
});

test("reads flattened New API ratio fields from a legacy log response", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/usage?days=7")) return new Response("not found", { status: 404 });
    if (url.endsWith("/api/usage/token/")) return new Response(JSON.stringify({
      data: { total_available: 1, unlimited_quota: false },
    }));
    if (url.includes("/api/log/token")) return new Response(JSON.stringify({
      data: { items: [{ prompt_tokens: 1, completion_tokens: 1, group_ratio: "0.11", created_at: 1785585600 }] },
    }));
    return new Response(JSON.stringify({ data: {} }));
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 7 });
  expect(result.billingMultiplier.value).toBe(0.11);
  expect(result.billingMultiplier.scope).toBe("group");
  expect(result.billingMultiplier.observedAt).toBe("2026-08-01T12:00:00.000Z");
});

test("keeps the New API billing multiplier unknown when all observed ratios are zero", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
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
  globalThis.fetch = (async (input: RequestInfo | URL) => {
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

test.each([4.5, 24.5])("queries signed account billing balance for an unlimited New API token (used %s)", async (used) => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
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
      return new Response(JSON.stringify({ total_usage: used * 100 }));
    }
    return new Response(JSON.stringify({ data: [] }));
  }) as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 30 });
  expect(result.quota).toEqual({ limit: 20, used, remaining: 20 - used, unlimited: true, unit: "USD" });
  expect(result.warning).toContain("账号级证据");
});

test("parses current Sub2API unrestricted wallet and nested total usage", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith("/v1/sub2api/billing") ? {} : {
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
  globalThis.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith("/v1/sub2api/billing") ? {} : {
    mode: "unrestricted",
    remaining: 70,
    unit: "USD",
    subscription: { monthly_limit_usd: 100, monthly_usage_usd: 30 },
  }))) as unknown as typeof fetch;

  const result = await queryUpstreamUsage(target, { timeoutMs: 100, days: 30 });
  expect(result.quota).toEqual({ limit: 100, used: 30, remaining: 70, unlimited: false, unit: "USD" });
});

test("parses OpenCode Go rolling, weekly and monthly quota windows", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    return new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 85, resets_at: "2026-11-08T07:00:00Z" },
        weekly: { status: "rate-limited", percent: 100, resets_at: "2026-11-09T00:00:00Z" },
        monthly: { status: "ok", percent: 40, resets_at: "2026-12-01T00:00:00Z" },
      },
      fetched_at: "2026-11-08T04:40:00Z",
    }), { status: 200 });
  }) as typeof fetch;

  const result = await queryUpstreamUsage({
    id: 1552,
    name: "opencode",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: "sk-test-secret-value",
  }, { timeoutMs: 100, days: 1, lowQuotaRemainingPercent: 20 });

  expect(requests).toEqual(["https://opencode.ai/zen/go/v1/usage?days=1"]);
  expect(result.ok).toBe(true);
  expect(result.provider).toBe("opencode-go");
  expect(result.window.complete).toBe(true);
  expect(result.quotaWindows.map((window) => ({
    window: window.window,
    remainingPercent: window.remainingPercent,
    resetAt: window.resetAt,
    source: window.source,
    observedAt: window.observedAt,
  }))).toEqual([
    { window: "five_hour", remainingPercent: 15, resetAt: "2026-11-08T07:00:00.000Z", source: "opencode:/v1/usage", observedAt: "2026-11-08T04:40:00.000Z" },
    { window: "weekly", remainingPercent: 0, resetAt: "2026-11-09T00:00:00.000Z", source: "opencode:/v1/usage", observedAt: "2026-11-08T04:40:00.000Z" },
    { window: "monthly", remainingPercent: 60, resetAt: "2026-12-01T00:00:00.000Z", source: "opencode:/v1/usage", observedAt: "2026-11-08T04:40:00.000Z" },
  ]);
  expect(result.lowQuotaWarnings.map((warning) => warning.window)).toEqual(["five_hour", "weekly"]);
});

test("parses CommandCode quota summary from the official origin endpoint", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/provider/v1/usage?days=1")) return new Response("not found", { status: 404 });
    if (url.endsWith("/alpha/usage/summary")) {
      return new Response(JSON.stringify({
        data: {
          usage_limits: [
            { window: "5h", used_percent: 30, resets_at: "2026-11-08T08:00:00Z" },
            { window: "weekly", used_percent: 70, resets_at: "2026-11-10T08:00:00Z" },
            { window: "monthly", used_percent: 50, resets_at: "2026-12-01T00:00:00Z" },
          ],
        },
        observed_at: "2026-11-08T04:41:00Z",
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await queryUpstreamUsage({
    id: 1580,
    name: "command-code",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    apiKey: "sk-test-secret-value",
  }, { timeoutMs: 100, days: 1, lowQuotaRemainingPercent: 20 });

  expect(requests).toEqual([
    "https://api.commandcode.ai/provider/v1/usage?days=1",
    "https://api.commandcode.ai/alpha/usage/summary",
  ]);
  expect(result.ok).toBe(true);
  expect(result.provider).toBe("command-code");
  expect(result.quotaWindows.map((window) => [window.window, window.remainingPercent])).toEqual([
    ["five_hour", 70],
    ["weekly", 30],
    ["monthly", 50],
  ]);
  expect(result.lowQuotaWarnings).toEqual([]);
});

test("falls back to CommandCode billing endpoints when usage summary has no quota windows", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/provider/v1/usage?days=1")) return new Response("not found", { status: 404 });
    if (url.endsWith("/alpha/usage/summary")) {
      return new Response(JSON.stringify({ totalMonthlyCredits: 200, totalCredits: 80 }), { status: 200 });
    }
    if (url.endsWith("/alpha/billing/credits")) {
      return new Response(JSON.stringify({
        credits: {
          belowThreshold: true,
          creditThreshold: 10,
          monthlyCredits: 30,
        },
        windowLimits: {
          limited: true,
          exceeded: false,
          fiveHour: { used: 18, cap: 20, exceeded: false, resetAt: "2026-11-08T09:00:00Z" },
          weekly: { used: 25, cap: 50, exceeded: false, resetAt: "2026-11-10T09:00:00Z" },
        },
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await queryUpstreamUsage({
    id: 1580,
    name: "command-code",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    apiKey: "sk-test-secret-value",
  }, { timeoutMs: 100, days: 1, lowQuotaRemainingPercent: 20 });

  expect(requests).toEqual([
    "https://api.commandcode.ai/provider/v1/usage?days=1",
    "https://api.commandcode.ai/alpha/usage/summary",
    "https://api.commandcode.ai/alpha/billing/credits",
  ]);
  expect(result.ok).toBe(true);
  expect(result.provider).toBe("command-code");
  expect(result.quotaWindows.find((window) => window.window === "five_hour")?.remainingPercent).toBe(10);
  expect(result.quotaWindows.find((window) => window.window === "monthly")).toMatchObject({
    remaining: 30,
    remainingPercent: null,
    unit: "credits",
    status: "low",
    complete: false,
    missingReason: "upstream-monthly-limit-or-percent-missing",
  });
  expect(result.lowQuotaWarnings).toHaveLength(1);
  expect(result.window.complete).toBe(false);
  expect(result.warning).toContain("monthly");
});

test("warns when CommandCode weekly usage exceeds its cap", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/provider/v1/usage?days=1")) return new Response("not found", { status: 404 });
    if (url.endsWith("/alpha/usage/summary")) return new Response(JSON.stringify({}), { status: 200 });
    if (url.endsWith("/alpha/billing/credits")) {
      return new Response(JSON.stringify({
        credits: { belowThreshold: false, monthlyCredits: 34.98 },
        windowLimits: {
          limited: true,
          exceeded: true,
          fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
          weekly: { used: 35.011, cap: 35, exceeded: true, resetAt: "2026-11-09T01:00:00Z" },
        },
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await queryUpstreamUsage({
    id: 1556,
    name: "command-code",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    apiKey: "sk-test-secret-value",
  }, { timeoutMs: 100, days: 1, lowQuotaRemainingPercent: 20 });

  const weekly = result.quotaWindows.find((window) => window.window === "weekly");
  const fiveHour = result.quotaWindows.find((window) => window.window === "five_hour");
  expect(fiveHour?.resetAt).toBeNull();
  expect(weekly).toMatchObject({ status: "rate-limited", complete: true });
  expect(weekly?.remainingPercent).toBe(-0.031);
  expect(result.lowQuotaWarnings).toEqual([expect.objectContaining({
    window: "weekly",
    remainingPercent: -0.031,
    thresholdPercent: 20,
  })]);
});

test("keeps absent provider quota windows unknown instead of zero", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(
    String(input).endsWith("/v1/usage?days=1")
      ? { data: { monthly: { status: "ok", percent: 25 } } }
      : {},
  ))) as unknown as typeof fetch;

  const result = await queryUpstreamUsage({
    id: 1552,
    name: "opencode",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: "sk-test-secret-value",
  }, { timeoutMs: 100, days: 1 });

  expect(result.ok).toBe(true);
  expect(result.quotaWindows.find((window) => window.window === "five_hour")).toMatchObject({
    remainingPercent: null,
    complete: false,
    missingReason: "upstream-response-missing-window",
  });
  expect(result.quotaWindows.find((window) => window.window === "monthly")?.remainingPercent).toBe(75);
  expect(result.window.complete).toBe(false);
  expect(result.warning).toContain("five_hour");
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
