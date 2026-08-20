import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "./config";
import { readSecret } from "./secrets";

type Json = Record<string, unknown>;

const secretFields = /(?:token|password|credential|secret|claim_url|authorization)/iu;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const result: Json = {};
  for (const [key, item] of Object.entries(value as Json)) {
    result[key] = secretFields.test(key) ? "[redacted]" : redact(item);
  }
  return result;
}

function safeError(value: unknown): string {
  if (typeof value === "string") return value.replace(/(cfk_[A-Za-z0-9_-]+|rt\.[A-Za-z0-9._-]+|Bearer\s+\S+)/gu, "[redacted]");
  const row = value && typeof value === "object" ? value as Json : null;
  return typeof row?.message === "string" ? safeError(row.message) : "upstream request failed";
}

export class BugTeamClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly token: string;

  constructor(private readonly config: AppConfig) {
    this.baseUrl = config.bugTeam.baseUrl;
    this.timeoutMs = config.bugTeam.requestTimeoutMs;
    this.token = readSecret(config, config.bugTeam.customerToken);
  }

  private async request<T extends Json>(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("X-Customer-Token", this.token);
    if (init.body) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(`BugTeam transport failed for ${path}: ${safeError(error)}`, { cause: error });
    }
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw new Error(`BugTeam ${path} returned HTTP ${response.status}: ${safeError(payload)}`);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`BugTeam ${path} returned invalid JSON`);
    return redact(payload) as T;
  }

  login(): Promise<Json> {
    const account = readSecret(this.config, this.config.bugTeam.customerAccount);
    const password = readSecret(this.config, this.config.bugTeam.customerPassword);
    return this.request<Json>("/api/customer/login", { method: "POST", body: JSON.stringify({ account, password }) });
  }
  balance(): Promise<Json> { return this.request("/api/customer/balance"); }
  inventory(product: string, quantity: number): Promise<Json> {
    return this.request(`/api/customer/inventory?product=${encodeURIComponent(product)}&quantity=${quantity}`);
  }
  inventoryShelves(product: string): Promise<Json> {
    return this.request(`/api/customer/inventory/shelves?product=${encodeURIComponent(product)}`);
  }
  createOrder(product: string, quantity: number, idempotencyKey: string, expiryBucketStart?: string): Promise<Json> {
    return this.request("/api/customer/pickup/orders", {
      method: "POST", headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ product, quantity, ...(expiryBucketStart ? { expiry_bucket_start: expiryBucketStart } : {}) }),
    }, Math.max(this.timeoutMs, 120000));
  }
  orderStatus(orderId: string): Promise<Json> { return this.request(`/api/customer/pickup/orders/${encodeURIComponent(orderId)}`); }
  take(orderId: string, idempotencyKey: string): Promise<Json> {
    return this.request(`/api/customer/pickup/orders/${encodeURIComponent(orderId)}/take`, {
      method: "POST", headers: { "Idempotency-Key": idempotencyKey },
    }, Math.max(this.timeoutMs, 120000));
  }
  push(orderId: string, hubId: string, idempotencyKey: string): Promise<Json> {
    return this.request(`/api/customer/pickup/orders/${encodeURIComponent(orderId)}/push`, {
      method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ hub_id: hubId }),
    }, Math.max(this.timeoutMs, 120000));
  }
  redeem(code: string, idempotencyKey: string): Promise<Json> {
    return this.request("/api/customer/redeem", {
      method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ code }),
    });
  }
  recoveries(state: string | null, limit: number, beforeId: string | null): Promise<Json> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (state) query.set("state", state);
    if (beforeId) query.set("before_id", beforeId);
    return this.request(`/api/customer/recoveries?${query}`);
  }
  async claim(recoveryId: string, ticket: string, idempotencyKey: string, outputPath: string): Promise<Json> {
    if (!ticket.trim()) throw new Error("recovery claim requires a ticket from --ticket-stdin");
    const response = await fetch(`${this.baseUrl}/api/customer/recoveries/${encodeURIComponent(recoveryId)}/claim`, {
      method: "POST",
      headers: { accept: "application/json", "X-Customer-Token": this.token, "X-Recovery-Ticket": ticket.trim(), "Idempotency-Key": idempotencyKey },
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120000)),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(`BugTeam recovery claim returned HTTP ${response.status}: ${safeError(payload)}`);
    }
    return await this.writeResponseFile(response, resolve(outputPath), { recoveryId });
  }
  async download(orderId: string, format: "sub2" | "cpa", outputPath: string): Promise<Json> {
    const response = await fetch(`${this.baseUrl}/api/customer/pickup/orders/${encodeURIComponent(orderId)}/download?format=${format}`, {
      headers: { accept: "application/octet-stream, application/json", "X-Customer-Token": this.token },
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120000)),
    });
    if (!response.ok) throw new Error(`BugTeam download returned HTTP ${response.status}`);
    return await this.writeResponseFile(response, resolve(outputPath), { orderId, format });
  }

  private async writeResponseFile(response: Response, path: string, metadata: Json): Promise<Json> {
    const bytes = new Uint8Array(await response.arrayBuffer());
    await mkdir(dirname(path), { recursive: true });
    const hash = createHash("sha256").update(bytes).digest("hex");
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createWriteStream(path, { flags: "wx" });
      stream.on("error", reject); stream.on("finish", resolvePromise); stream.end(bytes);
    });
    return { ok: true, ...metadata, output: path, bytes: bytes.byteLength, sha256: hash, credentialVersion: response.headers.get("X-Credential-Version"), valuesPrinted: false };
  }
}
