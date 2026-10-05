import { constants, createHash, publicEncrypt } from "node:crypto";
import { normalizeUpstreamWallet } from "./upstream-valuation";

export interface NewApiAuthTarget {
  baseUrl: string;
  walletKey?: string;
  newApiCredentials?: { username: string; password: string };
}

export interface NewApiSession {
  token: string;
  expiresAtMs: number;
  refreshCookie: string | null;
  sessionId: string | null;
}

export interface NewApiAuthCacheEntry {
  promise: Promise<NewApiSession>;
  retryAtMs?: number;
}

export type NewApiAuthCache = Map<string, NewApiAuthCacheEntry>;

// New API rejects repeated session issuance with HTTP 429. Keep that result
// for one conservative window instead of retrying on every ten-minute round.
const AUTH_FAILURE_BACKOFF_MS = 30 * 60_000;

export function newApiAuthCacheKey(target: NewApiAuthTarget): string {
  const identity = `${normalizeUpstreamWallet(target.walletKey ?? target.baseUrl)}\u0000${target.newApiCredentials?.username ?? ""}\u0000${target.newApiCredentials?.password ?? ""}`;
  return createHash("sha256").update(identity).digest("hex");
}

function data(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  if (root.success === false) return null;
  return root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : root;
}

function expiry(token: string, declared: unknown): number {
  if (typeof declared === "number" && declared > 0) return declared * 1000;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (typeof claims.exp === "number" && claims.exp > 0) return claims.exp * 1000;
  } catch { /* Opaque legacy tokens are refreshed after an authentication rejection. */ }
  return Number.MAX_SAFE_INTEGER;
}

async function payload(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function session(response: Response, value: unknown, previous?: NewApiSession): NewApiSession {
  const root = data(value);
  const token = typeof root?.access_token === "string" ? root.access_token : "";
  if (!response.ok || !token) {
    const code = value && typeof value === "object" ? (value as Record<string, unknown>).code : null;
    const suffix = typeof code === "string" && /^[A-Z_]+$/u.test(code) ? ` ${code}` : "";
    throw new Error(`New API session request failed: HTTP ${response.status}${suffix}`);
  }
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.map((item) => item.split(";", 1)[0]!).find((item) => item.startsWith("new_api_refresh="));
  const info = root?.session as Record<string, unknown> | undefined;
  return {
    token,
    expiresAtMs: expiry(token, root?.access_expires_at),
    refreshCookie: cookie ?? previous?.refreshCookie ?? null,
    sessionId: typeof info?.sid === "string" ? info.sid : previous?.sessionId ?? null,
  };
}

function origin(target: NewApiAuthTarget): string {
  return (target.walletKey ?? target.baseUrl).replace(/\/$/u, "").replace(/\/v1$/u, "");
}

async function login(target: NewApiAuthTarget, timeoutMs: number): Promise<NewApiSession> {
  const credentials = target.newApiCredentials;
  if (!credentials) throw new Error("New API login credentials are not configured");
  const base = origin(target);
  const keyResponse = await fetch(`${base}/api/user/login/encryption-key`, {
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs),
  });
  const key = data(await payload(keyResponse));
  let body: Record<string, string> = { username: credentials.username, password: credentials.password };
  if (keyResponse.ok && key?.enabled === true) {
    if (typeof key.kid !== "string" || typeof key.public_key !== "string") throw new Error("New API login encryption key unavailable");
    body = {
      username: credentials.username,
      password_encrypted: publicEncrypt({ key: key.public_key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(credentials.password)).toString("base64"),
      encryption_key_id: key.kid,
    };
  }
  const response = await fetch(`${base}/api/user/login`, {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  return session(response, await payload(response));
}

async function renew(target: NewApiAuthTarget, timeoutMs: number, previous: NewApiSession): Promise<NewApiSession> {
  if (!previous.refreshCookie) return await login(target, timeoutMs);
  const base = origin(target);
  const response = await fetch(`${base}/api/user/auth/refresh`, {
    method: "POST",
    headers: {
      accept: "application/json", origin: new URL(base).origin, cookie: previous.refreshCookie,
      ...(previous.sessionId ? { "x-auth-session": previous.sessionId } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401) {
    await response.arrayBuffer();
    return await login(target, timeoutMs);
  }
  return session(response, await payload(response), previous);
}

export async function newApiLoginSession(target: NewApiAuthTarget, timeoutMs: number, cache?: NewApiAuthCache, rejectedToken?: string): Promise<NewApiSession> {
  if (!cache) return await login(target, timeoutMs);
  const key = newApiAuthCacheKey(target);
  const cached = cache.get(key);
  if (cached?.retryAtMs !== undefined && cached.retryAtMs <= Date.now()) {
    if (cache.get(key) === cached) cache.delete(key);
  }
  const pending = cache.get(key);
  if (pending) {
    let previous: NewApiSession;
    try {
      previous = await pending.promise;
    } catch (error) {
      if (pending.retryAtMs === undefined || pending.retryAtMs <= Date.now()) {
        if (cache.get(key) === pending) cache.delete(key);
      }
      throw error;
    }
    if (previous.expiresAtMs > Date.now() + 60_000 && previous.token !== rejectedToken) return previous;
    // Another alias may have renewed the shared session while this request waited.
    if (cache.get(key) !== pending) return await newApiLoginSession(target, timeoutMs, cache, rejectedToken);
    const renewal = renew(target, timeoutMs, previous);
    const renewalEntry: NewApiAuthCacheEntry = { promise: renewal };
    cache.set(key, renewalEntry);
    try { return await renewal; } catch (error) {
      // Preserve the refresh credential after network/5xx failures for next round.
      if (/HTTP 429|AUTH_SESSION_ISSUANCE_LIMIT/u.test(String(error))) {
        if (cache.get(key) === renewalEntry) {
          cache.set(key, { promise: renewal, retryAtMs: Date.now() + AUTH_FAILURE_BACKOFF_MS });
        }
      } else if (cache.get(key) === renewalEntry) {
        cache.set(key, { promise: Promise.resolve(previous) });
      }
      throw error;
    }
  }
  const started = login(target, timeoutMs);
  const startedEntry: NewApiAuthCacheEntry = { promise: started };
  cache.set(key, startedEntry);
  try { return await started; } catch (error) {
    if (/HTTP 429|AUTH_SESSION_ISSUANCE_LIMIT/u.test(String(error))) {
      if (cache.get(key) === startedEntry) {
        cache.set(key, { promise: started, retryAtMs: Date.now() + AUTH_FAILURE_BACKOFF_MS });
      }
    } else if (cache.get(key) === startedEntry) {
      cache.delete(key);
    }
    throw error;
  }
}
