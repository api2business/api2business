import { createHash } from "node:crypto";
import type { Sub2ApiClient } from "./sub2api-client";

type Row = Record<string, unknown>;

interface ImportItem {
  index?: unknown;
  action?: unknown;
  account_id?: unknown;
  message?: unknown;
}

interface CodexImportResult {
  items?: unknown;
  failed?: unknown;
}

interface BatchCreateResult {
  success?: unknown;
  failed?: unknown;
  results?: unknown;
}

function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function identity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export class Sub2ApiRuntimeService {
  constructor(
    private readonly client: Sub2ApiClient,
    private readonly apiKeyFailoverRules: Array<{ error_code: number; keywords: string[]; duration_minutes: number }> = [],
  ) {}

  private apiKeyCredentials(value: unknown): Row {
    return {
      ...(record(value) ?? {}),
      pool_mode: false,
      temp_unschedulable_enabled: true,
      temp_unschedulable_rules: this.apiKeyFailoverRules,
    };
  }

  async importAccounts(input: {
    content: string;
    priority: number;
    capacity: number;
    groupIds: number[];
    proxyId: number;
    proxyCandidateIds: number[];
    perAccountProxy: boolean;
  }): Promise<Record<string, unknown>> {
    const payload = JSON.parse(input.content) as Row;
    const accounts = Array.isArray(payload.accounts) ? payload.accounts.map(record).filter((item): item is Row => item !== null) : [];
    if (accounts.length === 0) throw new Error("runtime import contains no accounts");
    const types = new Set(accounts.map((account) => String(account.type ?? "oauth").toLowerCase()));
    if (types.size !== 1) throw new Error("runtime import does not allow mixed OAuth and API-key accounts");
    const platforms = new Set(accounts.map((account) => String(account.platform ?? "").trim().toLowerCase()));
    if (platforms.size !== 1 || (![...platforms].includes("openai") && ![...platforms].includes("grok"))) {
      throw new Error("runtime import requires exactly one supported account platform");
    }
    const platform = [...platforms][0]!;
    const requestKey = `apistate-runtime-import-${identity({ payload, ...input, content: undefined })}`;
    const createdIds: number[] = [];
    const updatedIds: number[] = [];
    const skippedIds: number[] = [];
    const failures: Array<{ index: number; reason: string }> = [];
    let createdCount = 0;

    if (platform === "grok") {
      const prepared = accounts.map((account) => ({
        ...account,
        platform: "grok",
        type: "oauth",
        priority: input.priority,
        concurrency: input.capacity,
        proxy_id: input.proxyId,
        group_ids: input.groupIds,
        confirm_mixed_channel_risk: true,
      }));
      const result = await this.client.mutate<BatchCreateResult>("POST", "/admin/accounts/batch", {
        accounts: prepared,
      }, requestKey);
      const items = Array.isArray(result.results) ? result.results : [];
      for (let offset = 0; offset < items.length; offset += 1) {
        const item = record(items[offset]);
        const accountId = positiveInteger(item?.id);
        if (item?.success === true && accountId) createdIds.push(accountId);
        else failures.push({ index: offset + 1, reason: String(item?.error ?? "Sub2API Grok batch import failed") });
      }
      const reportedSuccess = Number(result.success ?? 0);
      const reportedFailed = Number(result.failed ?? 0);
      const classifiedFailed = failures.length;
      if (reportedSuccess !== createdIds.length || reportedFailed !== classifiedFailed || items.length !== accounts.length) {
        failures.push({ index: 0, reason: `Sub2API Grok batch result mismatch: items ${items.length}/${accounts.length}, success ${reportedSuccess}/${createdIds.length}, failed ${reportedFailed}/${classifiedFailed}` });
      }
    } else if (types.has("apikey")) {
      const prepared = accounts.map((account) => ({
        ...account,
        credentials: this.apiKeyCredentials(account.credentials),
        priority: input.priority,
        concurrency: input.capacity,
        proxy_id: input.proxyId,
        group_ids: input.groupIds,
      }));
      const result = await this.client.mutate<Row>("POST", "/admin/accounts/data", {
        data: { accounts: prepared, proxies: [] },
        skip_default_group_bind: true,
      }, requestKey);
      createdCount = Number(result.account_created ?? 0);
      const failed = Number(result.account_failed ?? 0);
      if (failed > 0 || createdCount !== accounts.length) {
        failures.push({ index: 0, reason: `Sub2API data import created ${createdCount}/${accounts.length}, failed ${failed}` });
      }
    } else {
      const credentials = accounts.map((account) => JSON.stringify(record(account.credentials) ?? {}));
      const result = await this.client.mutate<CodexImportResult>("POST", "/admin/accounts/import/codex-session", {
        contents: credentials,
        group_ids: input.groupIds,
        proxy_id: input.proxyId,
        concurrency: input.capacity,
        priority: input.priority,
        auto_pause_on_expired: accounts.every((account) => account.auto_pause_on_expired !== false),
        update_existing: false,
        skip_default_group_bind: true,
        confirm_mixed_channel_risk: true,
      }, requestKey);
      const items = Array.isArray(result.items) ? result.items as ImportItem[] : [];
      for (let offset = 0; offset < items.length; offset += 1) {
        const item = items[offset]!;
        const index = positiveInteger(item.index) ?? offset + 1;
        const accountId = positiveInteger(item.account_id);
        const action = String(item.action ?? "").toLowerCase();
        if (accountId && action === "created") createdIds.push(accountId);
        else if (accountId && action === "updated") updatedIds.push(accountId);
        else if (accountId && action === "skipped") skippedIds.push(accountId);
        else if (!accountId || action === "failed") failures.push({ index, reason: String(item.message ?? "Sub2API import failed") });
      }
      if (Number(result.failed ?? 0) > failures.length) failures.push({ index: 0, reason: "Sub2API import reported unclassified failures" });
    }

    const importedIds = [...createdIds, ...updatedIds];
    const proxyAssignments: Array<Record<string, unknown>> = [];
    if (input.perAccountProxy && importedIds.length > 0) {
      for (const [offset, accountId] of importedIds.entries()) {
        const proxyId = input.proxyCandidateIds[Math.floor(Math.random() * input.proxyCandidateIds.length)]!;
        await this.updateAccount(accountId, { proxy_id: proxyId });
        proxyAssignments.push({ index: offset + 1, accountId, proxyId, bound: true });
      }
    }
    return {
      ok: failures.length === 0,
      action: "apistate-sub2api-runtime-import",
      mode: "confirmed",
      mutation: createdCount + createdIds.length + updatedIds.length > 0,
      result: {
        createdIds,
        createdCount: createdCount + createdIds.length,
        updatedIds,
        skippedIds,
        skipped: skippedIds.length,
        failed: failures.length,
        failures,
        proxyAssignments,
        sharedProxyId: input.perAccountProxy ? null : input.proxyId,
      },
      valuesPrinted: false,
    };
  }

  async createApiKeyAccount(account: Row, idempotencyKey: string): Promise<Record<string, unknown>> {
    return await this.client.mutate("POST", "/admin/accounts/data", {
      data: { accounts: [{ ...account, credentials: this.apiKeyCredentials(account.credentials) }], proxies: [] },
      skip_default_group_bind: true,
    }, idempotencyKey);
  }

  async updateAccount(accountId: number, patch: Row): Promise<unknown> {
    return await this.client.mutate("PUT", `/admin/accounts/${accountId}`, patch);
  }

  async applyApiKeyFailoverTemplate(accountId: number): Promise<unknown> {
    const account = await this.client.getAccount(accountId);
    if (String(account.type ?? "").toLowerCase() !== "apikey") {
      throw new Error(`account ${accountId} is not an API-key account`);
    }
    return await this.updateAccount(accountId, {
      credentials: this.apiKeyCredentials(account.credentials),
    });
  }

  async setSchedulable(accountId: number, schedulable: boolean): Promise<unknown> {
    return await this.client.mutate("POST", `/admin/accounts/${accountId}/schedulable`, { schedulable });
  }

  async recoverAccount(accountId: number): Promise<void> {
    await this.updateAccount(accountId, { status: "active" });
    await this.setSchedulable(accountId, true);
  }

  async updatePriorities(priorities: Record<string, number>): Promise<unknown> {
    const items = [];
    for (const [id, priority] of Object.entries(priorities).sort(([left], [right]) => Number(left) - Number(right))) {
      await this.updateAccount(Number(id), { priority });
      items.push({ accountId: Number(id), priority, updated: true });
    }
    return { updated: items.length, items };
  }

  async testAccount(accountId: number, model: string): Promise<unknown> {
    const startedAt = Date.now();
    const response = await this.client.requestRaw("POST", `/admin/accounts/${accountId}/test`, { model_id: model });
    const events = response.body.split(/\r?\n/u).flatMap((line) => {
      if (!line.startsWith("data:")) return [];
      try { return [JSON.parse(line.slice(5).trim()) as Row]; } catch { return []; }
    });
    if (events.some((event) => event.type === "test_complete" && event.success === true)) {
      return { accountId, classification: "alive", reason: "test-complete", httpStatus: response.httpStatus, durationMs: Date.now() - startedAt, error: null };
    }
    const error = events.filter((event) => event.type === "error" && event.error).map((event) => String(event.error)).at(-1) ?? response.body.slice(0, 500);
    const lowered = error.toLowerCase();
    const dead = ["invalid_grant", "token has been revoked", "token was revoked", "refresh token expired", "access token expired", "token is expired", "account deactivated", "workspace has been deactivated", "no access token available", "authentication token is invalid", "invalid authentication", "http 401", "returned 401", "api returned 401"].some((marker) => lowered.includes(marker));
    return { accountId, classification: dead ? "dead" : "unknown", reason: dead ? "authentication-terminal" : "test-inconclusive", httpStatus: response.httpStatus, durationMs: Date.now() - startedAt, error: error || null };
  }

  async deleteAccount(accountId: number): Promise<unknown> {
    return await this.client.mutate("DELETE", `/admin/accounts/${accountId}`);
  }
}
