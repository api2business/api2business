import { createHash } from "node:crypto";
import { link, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function safeError(value: unknown): string {
  const row = object(value);
  if (typeof value === "string") return value
    .replace(/(?:team-[A-Za-z0-9-]+|sk-[A-Za-z0-9]+|Bearer\s+\S+)/gu, "[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[redacted]")
    .slice(0, 300);
  return typeof row?.message === "string" ? safeError(row.message) : "public recovery request failed";
}

export function validatePublicRecoveryBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/$/u, "");
  let parsed: URL;
  try { parsed = new URL(baseUrl); }
  catch { throw new Error("--base-url must be a valid HTTPS URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("--base-url must be an HTTPS origin without credentials, path, query, or hash");
  }
  return baseUrl;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function findString(value: unknown, keys: Set<string>): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, keys);
      if (found) return found;
    }
    return null;
  }
  const row = object(value);
  if (!row) return null;
  for (const [key, item] of Object.entries(row)) {
    if (keys.has(key.toLowerCase())) {
      const found = text(item);
      if (found) return found;
    }
  }
  for (const item of Object.values(row)) {
    const found = findString(item, keys);
    if (found) return found;
  }
  return null;
}

function statusProjection(payload: Json): Json {
  const taskValues: unknown[] = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) taskValues.push(...value);
    const row = object(value);
    if (!row) return;
    for (const [key, item] of Object.entries(row)) {
      if (["tasks", "orders", "items", "results", "data"].includes(key.toLowerCase())) collect(item);
    }
  };
  collect(payload);
  const taskStates = taskValues.map((item) => object(item)?.status ?? object(item)?.state).filter((item): item is string => typeof item === "string");
  const projected: Json = {
    ok: payload.ok,
    taskCount: taskValues.length || undefined,
    taskStates: taskStates.length ? taskStates : undefined,
    healthy: payload.healthy,
    needReclaim: payload.need_reclaim ?? payload.needReclaim,
    noAction: payload.no_action ?? payload.noAction,
    message: typeof payload.message === "string" ? safeError(payload.message) : undefined,
    valuesPrinted: false,
  };
  return Object.fromEntries(Object.entries(projected).filter(([, value]) => value !== undefined));
}

export class PublicRecoveryClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly timeoutMs: number) {
    this.baseUrl = validatePublicRecoveryBaseUrl(baseUrl);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("public recovery timeout must be between 1000 and 120000ms");
  }

  private async request(path: string, body: Json): Promise<Json> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`30d.team transport failed for ${path}: ${safeError(error)}`, { cause: error });
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`30d.team ${path} returned HTTP ${response.status}: ${safeError(payload)}`);
    const row = object(payload);
    if (!row) throw new Error(`30d.team ${path} returned invalid JSON`);
    return row;
  }

  async health(cardCode: string): Promise<Json> {
    const payload = await this.request("/api/redeem/reclaim/health-check", { card_codes: [cardCode] });
    return { action: "public-recovery-health", ...statusProjection(payload) };
  }

  async status(cardCode: string): Promise<Json> {
    const payload = await this.request("/api/redeem/reclaim/batch-cards", { card_codes: [cardCode], query_only: true });
    return { action: "public-recovery-status", ...statusProjection(payload) };
  }

  async reclaim(cardCode: string, mode: "401"): Promise<Json> {
    const payload = await this.request("/api/redeem/reclaim/batch-cards", { card_codes: [cardCode], mode });
    return { action: "public-recovery-reclaim", ...statusProjection(payload) };
  }

  async download(cardCode: string, outputPath: string): Promise<Json> {
    const path = resolve(outputPath);
    try {
      await stat(path);
      throw new Error(`output already exists: ${path}`);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    await mkdir(dirname(path), { recursive: true });
    const payload = await this.request("/api/redeem/reclaim/batch-cards", { card_codes: [cardCode], query_only: true });
    const orderNo = findString(payload, new Set(["order_no", "orderno", "orderNo"]));
    const downloadToken = findString(payload, new Set(["download_token", "downloadtoken", "downloadToken"]));
    if (!orderNo || !downloadToken) throw new Error("30d.team recovery has no downloadable order; run health/status and verify the card state first");

    const temporary = `${path}.tmp-${crypto.randomUUID()}`;
    try {
      const response = await fetch(`${this.baseUrl}/api/redeem/orders/${encodeURIComponent(orderNo)}/download?token=${encodeURIComponent(downloadToken)}`, {
        headers: { accept: "application/octet-stream, application/json" },
        signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120000)),
      });
      if (!response.ok) {
        const failure = await response.text().catch(() => "");
        throw new Error(`30d.team download returned HTTP ${response.status}: ${safeError(failure)}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      await writeFile(temporary, bytes, { flag: "wx" });
      await link(temporary, path);
      await unlink(temporary);
      return {
        ok: true,
        action: "public-recovery-download",
        output: path,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        format: "json-object-or-array",
        valuesPrinted: false,
      };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
