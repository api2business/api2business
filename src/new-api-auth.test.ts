import { afterEach, expect, test } from "bun:test";
import { newApiLoginSession, type NewApiAuthCache } from "./new-api-auth";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("unrelated HTTP 409 does not suppress a later wallet login", async () => {
  let logins = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/encryption-key")) return Response.json({ data: { enabled: false } });
    logins += 1;
    return Response.json({ code: "OTHER_CONFLICT" }, { status: 409 });
  }) as typeof fetch;
  const cache: NewApiAuthCache = new Map();
  const target = { baseUrl: "https://wallet.example", newApiCredentials: { username: "fixture-user", password: "fixture-password" } };
  await expect(newApiLoginSession(target, 100, cache)).rejects.toThrow("OTHER_CONFLICT");
  await expect(newApiLoginSession(target, 100, cache)).rejects.toThrow("OTHER_CONFLICT");
  expect(logins).toBe(2);
  expect(cache.size).toBe(0);
});

test("session-limit backoff expires and permits a successful retry", async () => {
  let logins = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/encryption-key")) return Response.json({ data: { enabled: false } });
    logins += 1;
    return logins === 1
      ? Response.json({ code: "AUTH_SESSION_LIMIT" }, { status: 409 })
      : Response.json({ data: { access_token: "fixture-access-token" } });
  }) as typeof fetch;
  const cache: NewApiAuthCache = new Map();
  const target = { baseUrl: "https://wallet.example", newApiCredentials: { username: "fixture-user", password: "fixture-password" } };
  await expect(newApiLoginSession(target, 100, cache)).rejects.toThrow("AUTH_SESSION_LIMIT");
  await expect(newApiLoginSession(target, 100, cache)).rejects.toThrow("AUTH_SESSION_LIMIT");
  expect(logins).toBe(1);
  for (const entry of cache.values()) entry.retryAtMs = Date.now() - 1;
  expect((await newApiLoginSession(target, 100, cache)).token).toBe("fixture-access-token");
  expect(logins).toBe(2);
});
