import { expect, test } from "bun:test";
import type { AppConfig } from "./config";
import { Sub2ApiClient } from "./sub2api-client";

test("Sub2API authentication and the requested operation share one timeout budget", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalTimeout = AbortSignal.timeout;
  let now = 1_000;
  const timeouts: number[] = [];
  Date.now = () => now;
  AbortSignal.timeout = ((milliseconds: number) => {
    timeouts.push(milliseconds);
    return originalTimeout(1_000);
  }) as typeof AbortSignal.timeout;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/auth/login")) {
      now += 60;
      return new Response(JSON.stringify({ code: 0, message: "ok", data: { access_token: "test-token" } }));
    }
    return new Response(JSON.stringify({ code: 0, message: "ok", data: { ok: true } }));
  }) as typeof fetch;

  try {
    const config = {
      sub2api: { baseUrl: "https://api.example.test/api/v1", requestTimeoutMs: 100 },
    } as AppConfig;
    const client = new Sub2ApiClient(config, { email: "test@example.test", password: "test-password" });
    expect(await client.request("/admin/accounts/1")).toEqual({ ok: true });
    expect(timeouts).toEqual([100, 40]);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    AbortSignal.timeout = originalTimeout;
  }
});
