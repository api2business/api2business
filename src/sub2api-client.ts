import type { AppConfig } from "./config";
import type { RankingSourceRow, Sub2ApiUser } from "./types";

interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export class Sub2ApiClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly credentials: { email: string; password: string },
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, authenticate = true): Promise<T> {
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

  async addBalance(userId: number, amountUsd: number, notes: string): Promise<Sub2ApiUser> {
    return await this.request(`/admin/users/${userId}/balance`, {
      method: "POST",
      body: JSON.stringify({ balance: amountUsd, operation: "add", notes }),
    });
  }
}
