import type { AppConfig } from "./config";
import type { RankingSourceRow, Sub2ApiUser } from "./types";

interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface Sub2ApiGroup {
  id: number;
  name: string;
  platform: string;
  status: string;
}

export interface Sub2ApiAccount {
  id: number;
  name: string;
  platform: string;
  status: string;
  schedulable?: boolean;
  priority?: number;
}

export interface Sub2ApiUsageRow {
  id: number;
  account_id: number | null;
  group_id: number | null;
  model: string;
  stream: boolean;
  input_tokens: number;
  output_tokens: number;
  actual_cost: number;
  duration_ms: number | null;
  first_token_ms: number | null;
  created_at: string;
}

export interface Sub2ApiRequestError {
  id: number;
  request_id?: string;
  account_id?: number | null;
  status_code?: number;
  phase?: string;
  type?: string;
  message?: string;
  error_message?: string;
}

export interface Sub2ApiSystemLog {
  id: number;
  created_at: string;
  message: string;
  request_id?: string;
  account_id?: number | null;
  extra?: Record<string, unknown>;
}

export class Sub2ApiClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly credentials: { email: string; password: string },
  ) {}

  async request<T>(path: string, init: RequestInit = {}, authenticate = true): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    if (authenticate) headers.set("authorization", `Bearer ${await this.accessToken()}`);
    const response = await fetch(`${this.config.sub2api.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.config.sub2api.requestTimeoutMs),
    });
    const payload = (await response.json().catch(() => null)) as Envelope<T> | null;
    if (!response.ok || !payload || payload.code !== 0) throw new Error(`Sub2API ${init.method ?? "GET"} ${path} failed: HTTP ${response.status} ${payload?.message ?? "invalid response"}`);
    return payload.data;
  }

  async mutate<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers = new Headers();
    if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
    return await this.request<T>(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async requestRaw(method: "GET" | "POST", path: string, body?: unknown): Promise<{ httpStatus: number; body: string }> {
    const headers = new Headers({ accept: "application/json", authorization: `Bearer ${await this.accessToken()}` });
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await fetch(`${this.config.sub2api.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.sub2api.requestTimeoutMs),
    });
    return { httpStatus: response.status, body: await response.text() };
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const data = await this.request<{ access_token: string; expires_in?: number }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(this.credentials),
    }, false);
    if (!data.access_token) throw new Error("Sub2API login response is missing access_token");
    this.token = data.access_token;
    const lifetimeSeconds = data.expires_in && data.expires_in > 120 ? data.expires_in - 60 : 300;
    this.tokenExpiresAt = Date.now() + lifetimeSeconds * 1000;
    return this.token;
  }

  async listUsers(): Promise<Sub2ApiUser[]> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const users = new Map<number, Sub2ApiUser>();
      let expectedTotal = 0;
      let page = 1;
      for (;;) {
        const params = new URLSearchParams({
          page: String(page),
          page_size: String(this.config.sub2api.pageSize),
          sort_by: "id",
          sort_order: "asc",
        });
        const data = await this.request<Paginated<Sub2ApiUser>>(`/admin/users?${params}`);
        expectedTotal = data.total;
        for (const user of data.items) users.set(user.id, user);
        if (page >= data.pages) break;
        page += 1;
      }
      if (users.size === expectedTotal) return [...users.values()].sort((left, right) => left.id - right.id);
    }
    throw new Error("Sub2API user list changed during pagination; retry the operation");
  }

  async getUsageRanking(startDate: string, endDate: string): Promise<{ ranking: RankingSourceRow[]; total_actual_cost: number; total_requests: number; total_tokens: number }> {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      timezone: this.config.ranking.timezone,
      limit: String(this.config.ranking.sourceLimit),
    });
    return await this.request(`/admin/dashboard/users-ranking?${params}`);
  }

  async listGroups(): Promise<Sub2ApiGroup[]> {
    return await this.request<Sub2ApiGroup[]>("/admin/groups/all");
  }

  async getAccount(id: number): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>(`/admin/accounts/${id}`);
  }

  async listGroupAccounts(groupId: number, platform: string): Promise<Sub2ApiAccount[]> {
    const params = new URLSearchParams({
      page: "1",
      page_size: "1000",
      group: String(groupId),
      platform,
      sort_by: "id",
      sort_order: "asc",
    });
    return (await this.request<Paginated<Sub2ApiAccount>>(`/admin/accounts?${params}`)).items;
  }

  async listGroupUsage(groupId: number, start: Date, end: Date): Promise<Sub2ApiUsageRow[]> {
    return await this.paginate<Sub2ApiUsageRow>("/admin/usage", {
      group_id: String(groupId),
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
      timezone: "UTC",
      sort_by: "created_at",
      sort_order: "desc",
    }, 1000, (row) => {
      const createdAt = Date.parse(row.created_at);
      return Number.isFinite(createdAt) && createdAt >= start.getTime() && createdAt <= end.getTime();
    });
  }

  async listRequestErrors(groupId: number, platform: string, start: Date): Promise<Sub2ApiRequestError[]> {
    return await this.paginate<Sub2ApiRequestError>("/admin/ops/request-errors", {
      group_id: String(groupId),
      platform,
      start_time: start.toISOString(),
      view: "all",
    }, 500);
  }

  async listSystemLogs(platform: string, start: Date, marker: string): Promise<Sub2ApiSystemLog[]> {
    return await this.paginate<Sub2ApiSystemLog>("/admin/ops/system-logs", {
      platform,
      start_time: start.toISOString(),
      q: marker,
    }, 200);
  }

  async getOpsOverview(groupId: number, platform: string, start: Date): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({
      group_id: String(groupId),
      platform,
      start_time: start.toISOString(),
      query_mode: "raw",
    });
    return await this.request(`/admin/ops/dashboard/overview?${params}`);
  }

  async getOpsAccountAvailability(groupId: number, platform: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ group_id: String(groupId), platform });
    return await this.request(`/admin/ops/account-availability?${params}`);
  }

  async getOpsConcurrency(groupId: number, platform: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ group_id: String(groupId), platform });
    return await this.request(`/admin/ops/concurrency?${params}`);
  }

  private async paginate<T>(path: string, query: Record<string, string>, pageSize: number, keep: (row: T) => boolean = () => true): Promise<T[]> {
    const rows: T[] = [];
    let page = 1;
    for (;;) {
      const params = new URLSearchParams({ ...query, page: String(page), page_size: String(pageSize) });
      const data = await this.request<Paginated<T>>(`${path}?${params}`);
      rows.push(...data.items.filter(keep));
      if (page >= data.pages) return rows;
      page += 1;
    }
  }

  async addBalance(userId: number, amountUsd: number, notes: string): Promise<Sub2ApiUser> {
    return await this.request(`/admin/users/${userId}/balance`, {
      method: "POST",
      body: JSON.stringify({ balance: amountUsd, operation: "add", notes }),
    });
  }
}
