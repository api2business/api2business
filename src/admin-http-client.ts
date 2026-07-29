import type { AppConfig, HttpCliTarget } from "./config";
import type { OperationRequest } from "./contracts";
import { readSecret } from "./secrets";

export class AdminHttpClient {
  private readonly token: string;

  constructor(private readonly config: AppConfig, private readonly target: HttpCliTarget) {
    if ("envKey" in target.adminToken) {
      const value = process.env[target.adminToken.envKey];
      if (!value) throw new Error(`HTTP CLI target requires env ${target.adminToken.envKey}`);
      this.token = value;
    } else {
      this.token = readSecret(config, target.adminToken);
    }
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = this.config.sub2api.requestTimeoutMs): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.body) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await fetch(`${this.target.baseUrl.replace(/\/$/u, "")}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`ApiState API transport failed for ${path}: ${message}`, { cause: error });
    }
    const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !payload) {
      const detail = payload?.error ? `: ${payload.error}` : "";
      throw new Error(`ApiState API ${path} returned HTTP ${response.status}${detail}`);
    }
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
  rankScores(recentCallLimit: number, accountSelector: string | null, groupSelector: string | null): Promise<Record<string, unknown>> {
    return this.request("/api/scores/rank", {
      method: "POST",
      body: JSON.stringify({ recentCallLimit, accountSelector, groupSelector }),
    }, 60000);
  }
  ranking(): Promise<Record<string, unknown>> { return this.request("/api/ranking"); }
  lottery(): Promise<Record<string, unknown>> { return this.request("/api/lottery"); }
  workflowSubmit(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/api/admin/workflows", { method: "POST", body: JSON.stringify({ command }) });
  }
  workflowStatus(id: string): Promise<Record<string, unknown>> {
    return this.request(`/api/admin/workflows/${encodeURIComponent(id)}`);
  }
  priorityAutomation(): Promise<Record<string, unknown>> { return this.request("/api/operations/priority-automation"); }
  priorityHistory(): Promise<Record<string, unknown>> { return this.request("/api/operations/priority-history"); }
  accountImport(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/api/account-import/jobs", { method: "POST", body: JSON.stringify(input) }, 30000);
  }
  accountImportStatus(id: string): Promise<Record<string, unknown>> {
    return this.request(`/api/account-import/jobs/${encodeURIComponent(id)}`);
  }
  accountBatchEconomics(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/api/admin/accounts/economics", {
      method: "POST",
      body: JSON.stringify(input),
    }, 60000);
  }
  alipayRevenue(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/api/admin/payments/alipay-revenue", {
      method: "POST",
      body: JSON.stringify(input),
    }, 60000);
  }
  userBalanceLiability(): Promise<Record<string, unknown>> {
    return this.request("/api/admin/users/balance-liability", {}, 60000);
  }
  createPriorityPlan(recentCallLimit: number): Promise<Record<string, unknown>> {
    return this.request("/api/operations/priority-plans", { method: "POST", body: JSON.stringify({ recentCallLimit }) }, 60000);
  }
  confirmPriorityPlan(id: string): Promise<Record<string, unknown>> {
    return this.request(`/api/operations/priority-plans/${encodeURIComponent(id)}/confirm`, { method: "POST", body: "{}" }, 240000);
  }
  createPriorityAutomation(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/api/operations/priority-automation", { method: "POST", body: JSON.stringify(input) });
  }
  updatePriorityAutomation(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/api/operations/priority-automation", { method: "PATCH", body: JSON.stringify(input) });
  }
  deletePriorityAutomation(): Promise<Record<string, unknown>> {
    return this.request("/api/operations/priority-automation", { method: "DELETE" });
  }
  priorityState(
    recentCallLimit: number,
    account: string | null,
    group: string | null,
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ recentCallLimit: String(recentCallLimit) });
    if (account) query.set("account", account);
    if (group) query.set("group", group);
    return this.request(
      `/api/operations/priority-state?${query}`,
      {},
      60000,
    );
  }
  ledger(period?: string): Promise<Record<string, unknown>> {
    const query = period ? `?period=${encodeURIComponent(period)}` : "";
    return this.request(`/api/operations/ledger${query}`, {}, 60000);
  }
  readStatus(): Promise<Record<string, unknown>> {
    return this.request("/api/admin/read-status");
  }
  errorAggregate(
    limit: number,
    top: number,
    account: string | null,
    group: string | null,
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({
      limit: String(limit),
      top: String(top),
    });
    if (account) query.set("account", account);
    if (group) query.set("group", group);
    return this.request(`/api/admin/errors/aggregate?${query}`, {}, 60000);
  }
  errorList(limit: number): Promise<Record<string, unknown>> {
    return this.request(`/api/admin/errors?limit=${limit}`, {}, 60000);
  }
  errorRequest(requestId: string): Promise<Record<string, unknown>> {
    return this.request(
      `/api/admin/errors/${encodeURIComponent(requestId)}`,
      {},
      60000,
    );
  }
  userImpact(
    start: string,
    end: string,
    affectedOnly: boolean,
  ): Promise<Record<string, unknown>> {
    return this.request("/api/admin/users/impact", {
      method: "POST",
      body: JSON.stringify({ start, end, affectedOnly }),
    }, 60000);
  }
  async executeOperation(operation: OperationRequest): Promise<unknown> {
    const response = await this.request<Record<string, unknown>>(
      "/api/internal/execute-operation",
      { method: "POST", body: JSON.stringify(operation) },
      60000,
    );
    if (response.operationId !== operation.operationId) {
      throw new Error("ApiState internal operation response identity mismatch");
    }
    return response.result;
  }
  runDueAutomation(): Promise<Record<string, unknown>> {
    return this.request(
      "/api/internal/priority-automation/run-due",
      { method: "POST", body: "{}" },
      this.config.operations.automationRunTimeoutMs + 30000,
    );
  }
}
