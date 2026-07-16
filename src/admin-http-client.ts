import type { AppConfig, HttpCliTarget } from "./config";
import { readSecret } from "./secrets";

export class AdminHttpClient {
  private readonly token: string;

  constructor(private readonly config: AppConfig, private readonly target: HttpCliTarget) {
    this.token = readSecret(config, target.adminToken);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.body) headers.set("content-type", "application/json");
    const response = await fetch(`${this.target.baseUrl.replace(/\/$/u, "")}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.config.sub2api.requestTimeoutMs),
    });
    const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !payload) throw new Error(payload?.error ?? `ApiState API failed with HTTP ${response.status}`);
    return payload as T;
  }

  status(): Promise<Record<string, unknown>> { return this.request("/api/admin/status"); }
  backendCheck(): Promise<Record<string, unknown>> { return this.request("/api/admin/backend-check"); }
  draw(): Promise<Record<string, unknown>> { return this.request("/api/admin/draw", { method: "POST" }); }
  reset(draws: number, includeRecords: boolean): Promise<Record<string, unknown>> {
    return this.request("/api/admin/reset", { method: "POST", body: JSON.stringify({ draws, includeRecords }) });
  }
  records(limit: number): Promise<Record<string, unknown>> { return this.request(`/api/admin/records?limit=${limit}`); }
  deleteRecord(id: string): Promise<Record<string, unknown>> { return this.request(`/api/admin/records/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  creditTest(execute: boolean): Promise<Record<string, unknown>> { return this.request("/api/admin/credit-test", { method: "POST", body: JSON.stringify({ execute }) }); }
  serviceStatus(): Promise<Record<string, unknown>> { return this.request("/api/status"); }
  scores(): Promise<Record<string, unknown>> { return this.request("/api/scores"); }
  refreshScores(): Promise<Record<string, unknown>> { return this.request("/api/scores/refresh", { method: "POST", body: "{}" }); }
  ranking(): Promise<Record<string, unknown>> { return this.request("/api/ranking"); }
  lottery(): Promise<Record<string, unknown>> { return this.request("/api/lottery"); }
}
