import type { AppConfig } from "./config";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import type { Sub2ApiRuntimeService } from "./sub2api-runtime-service";
import type { TemporalGateway } from "./temporal-client";
import type { ProbeIsolationService } from "./probe-isolation";
import {
  queryUpstreamUsageConcurrently,
  type UpstreamUsageResult,
  type UpstreamUsageTarget,
} from "./upstream-usage";
import {
  readUpstreamRechargeCosts,
  rechargeTotalsByAccount,
  recordUpstreamRechargeCost,
  type UpstreamRechargeCostEntry,
} from "./upstream-recharge-ledger";
import {
  normalizeUpstreamWallet,
  readUpstreamValuationPolicy,
  upstreamBalanceRateByWallet,
} from "./upstream-valuation";

type Row = Record<string, unknown>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Row;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface UpstreamManagementErrorDetails {
  operation?: string;
  partial?: boolean;
  accountId?: number;
  accounting?: Record<string, unknown>;
}

export class UpstreamManagementError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly details: UpstreamManagementErrorDetails = {},
  ) {
    super(message);
    this.name = "UpstreamManagementError";
  }
}

export interface UpstreamAccount {
  id: number;
  name: string;
  baseUrl: string;
  suffix: string | null;
  rateCnyPerApiUsd: number | null;
  keyPrefix: string | null;
  platform: string;
  type: string;
  status: string;
  schedulable: boolean;
  priority: number | null;
  capacity: number | null;
  proxyId: number | null;
  groupIds: number[];
  groupNames: string[];
  createdAt: string | null;
  updatedAt: string | null;
  rechargeCny: number;
  rechargeCount: number;
}

export interface UpstreamCreateInput {
  baseUrl: string;
  apiKey: string;
  suffix: string;
  rateCnyPerApiUsd: number;
  rateWasSpecified: boolean;
  rechargeCny: number | null;
  priority: number;
  capacity: number;
  groupIds: number[];
  operationId: string;
  description?: string;
}

export type UpstreamWorkerOperation =
  | { action: "create"; input: UpstreamCreateInput }
  | { action: "update"; input: { id: number; suffix?: string; rateCnyPerApiUsd?: number } }
  | { action: "recharge"; input: { id: number; amountCny: number; operationId: string; description?: string } }
  | { action: "isolation"; input: { accountIds: number[] } }
  | { action: "template"; input: { accountIds: number[] } }
  | { action: "usage"; input: { accountIds: number[] } };

const accountSelect = `
  SELECT
    a.id,
    a.name,
    a.platform,
    a.type,
    a.status,
    COALESCE(a.schedulable, false) AS schedulable,
    a.priority,
    a.concurrency AS capacity,
    a.proxy_id,
    a.created_at,
    a.updated_at,
    RTRIM(COALESCE(a.credentials->>'base_url', ''), '/') AS base_url,
    CASE
      WHEN COALESCE(a.credentials->>'api_key', '') = '' THEN ''
      ELSE LEFT(a.credentials->>'api_key', 8) || '...'
    END AS key_prefix,
    COUNT(*) FILTER (WHERE a.status = 'active' AND COALESCE(a.schedulable, false)) OVER()::int AS available_count,
    COALESCE(array_agg(DISTINCT ag.group_id) FILTER (WHERE ag.group_id IS NOT NULL), '{}') AS group_ids,
    COALESCE(array_agg(DISTINCT g.name) FILTER (WHERE g.name IS NOT NULL), '{}') AS group_names,
    COUNT(*) OVER()::int AS total_count
  FROM accounts a
  LEFT JOIN account_groups ag ON ag.account_id = a.id
  LEFT JOIN groups g ON g.id = ag.group_id AND g.deleted_at IS NULL
`;

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function arrayNumbers(value: unknown): number[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.replace(/^\{|\}$/gu, "").split(",").filter(Boolean) : [];
  return [...new Set(values.map(positiveInteger).filter((item): item is number => item !== null))].sort((a, b) => a - b);
}

function arrayStrings(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.replace(/^\{|\}$/gu, "").split(",").filter(Boolean) : [];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))].sort();
}

function localTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("base_url 必须是没有凭据、查询参数和片段的 HTTPS URL");
  }
  return parsed.toString().replace(/\/$/u, "");
}

export function validateSuffix(value: string): string {
  const suffix = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(suffix)) {
    throw new Error("后缀只能包含字母、数字、点、下划线或短横线，长度为 1 至 32");
  }
  return suffix;
}

export function validateRate(value: unknown): number {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1000
    || Math.abs(Math.round(rate * 1_000_000) - rate * 1_000_000) > 1e-7) {
    throw new Error("费率必须为正数且最多保留 6 位小数");
  }
  return rate;
}

export function validateRecharge(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0
    || Math.abs(Math.round(amount * 100) - amount * 100) > 1e-8) {
    throw new Error("充值金额必须为正数人民币且最多两位小数");
  }
  return money(amount);
}

export function validatePriority(value: unknown): number {
  const priority = Number(value);
  if (!Number.isSafeInteger(priority) || priority < 1 || priority > 1000) {
    throw new Error("初始优先级必须为 1 至 1000");
  }
  return priority;
}

export function validateCapacity(value: unknown): number {
  const capacity = Number(value);
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100000) {
    throw new Error("并发容量必须为 1 至 100000");
  }
  return capacity;
}

export function validateGroupIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !Number.isSafeInteger(Number(item)) || Number(item) < 1)) {
    throw new Error("至少选择一个有效号池");
  }
  const groupIds = [...new Set(value.map(Number))].sort((left, right) => left - right);
  if (groupIds.length === 0) throw new Error("至少选择一个有效号池");
  return groupIds;
}

export function formatRate(value: number): string {
  return value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

export function formatUpstreamName(baseUrl: string, suffix: string, rate: number): string {
  return `${normalizeBaseUrl(baseUrl)} ${validateSuffix(suffix)} ${formatRate(validateRate(rate))}`;
}

export function parseUpstreamName(name: string, baseUrl: string): { suffix: string; rateCnyPerApiUsd: number } | null {
  const normalizedBaseUrl = baseUrl.replace(/\/$/u, "");
  const prefix = `${normalizedBaseUrl} `;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length).trim();
  const separator = rest.lastIndexOf(" ");
  if (separator < 1) return null;
  const suffix = rest.slice(0, separator).trim();
  const rawRate = rest.slice(separator + 1).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(suffix) || !/^\d+(?:\.\d{1,6})?$/u.test(rawRate)) return null;
  const rate = Number(rawRate);
  return Number.isFinite(rate) && rate > 0 ? { suffix, rateCnyPerApiUsd: rate } : null;
}

function parseUpstreamNameTail(name: string): { suffix: string; rateCnyPerApiUsd: number } | null {
  const match = name.trim().match(/\s([A-Za-z0-9][A-Za-z0-9._-]{0,31})\s+(\d+(?:\.\d{1,6})?)$/u);
  if (!match) return null;
  const rate = Number(match[2]);
  return Number.isFinite(rate) && rate > 0 ? { suffix: match[1]!, rateCnyPerApiUsd: rate } : null;
}

function safeMessage(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_=+/.-]+/gu, "[REDACTED]")
    .replace(/rt\.\d\.[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/gu, "[REDACTED]")
    .slice(0, 500);
}

function parseJsonObject(stdout: string): Row | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const end = trimmed.lastIndexOf("}");
  if (end < 0) return null;
  const candidates: Row[] = [];
  for (let start = trimmed.lastIndexOf("{"); start >= 0; start = trimmed.lastIndexOf("{", start - 1)) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) candidates.push(parsed as Row);
    } catch {
      // Continue with the previous JSON object boundary.
    }
  }
  return candidates.find((candidate) => candidate.ok === true) ?? candidates[0] ?? null;
}

function nestedError(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return safeMessage(value.trim());
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Row;
  for (const key of ["error", "message", "stderrTail", "stdoutTail"]) {
    const message = nestedError(row[key]);
    if (message) return message;
  }
  for (const key of ["runtime", "remote", "data", "result", "projection"]) {
    const message = nestedError(row[key]);
    if (message) return message;
  }
  return null;
}

export function findAccountId(value: unknown): number | null {
  return findAccountIdIn(value, false);
}

function findAccountIdIn(value: unknown, allowPlainId: boolean): number | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAccountIdIn(item, allowPlainId);
      if (found !== null) return found;
    }
    return null;
  }
  const row = value as Row;
  for (const key of ["accountId", "account_id"]) {
    const id = positiveInteger(row[key]);
    if (id !== null) return id;
  }
  if (allowPlainId) {
    const id = positiveInteger(row.id);
    if (id !== null) return id;
  }
  for (const key of ["account", "accountInfo", "createdAccount", "accountData", "data", "runtime", "items", "actual", "result", "projection"]) {
    const found = findAccountIdIn(row[key], ["account", "accountInfo", "createdAccount", "accountData", "data"].includes(key));
    if (found !== null) return found;
  }
  return null;
}

function rowToAccount(row: Row, totals: Map<number, number>, entries: UpstreamRechargeCostEntry[]): UpstreamAccount {
  const id = positiveInteger(row.id) ?? 0;
  const baseUrl = String(row.base_url ?? "");
  const parsed = parseUpstreamName(String(row.name ?? ""), baseUrl);
  const accountEntries = entries.filter((entry) => entry.accountId === id);
  return {
    id,
    name: String(row.name ?? ""),
    baseUrl,
    suffix: parsed?.suffix ?? null,
    rateCnyPerApiUsd: parsed?.rateCnyPerApiUsd ?? null,
    keyPrefix: row.key_prefix ? String(row.key_prefix) : null,
    platform: String(row.platform ?? ""),
    type: String(row.type ?? ""),
    status: String(row.status ?? ""),
    schedulable: row.schedulable === true,
    priority: numeric(row.priority),
    capacity: numeric(row.capacity),
    proxyId: positiveInteger(row.proxy_id),
    groupIds: arrayNumbers(row.group_ids),
    groupNames: arrayStrings(row.group_names),
    createdAt: localTime(row.created_at),
    updatedAt: localTime(row.updated_at),
    rechargeCny: totals.get(id) ?? 0,
    rechargeCount: accountEntries.length,
  };
}

function rechargeTotal(entries: UpstreamRechargeCostEntry[]): number {
  return money(entries.reduce((sum, entry) => sum + entry.amountCny, 0));
}

function searchValue(value: string | null | undefined): string {
  return (value ?? "").trim().slice(0, 120);
}

function operationId(value: string | null | undefined, prefix: string): string {
  const candidate = (value ?? "").trim();
  if (candidate && candidate.length <= 160 && !/[\r\n]/u.test(candidate)) return candidate;
  return `${prefix}-${crypto.randomUUID()}`;
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof UpstreamManagementError
    && /account-name-already-exists|账号名称已存在|already exists/iu.test(error.message);
}

export class UpstreamManagementService {
  private ledgerWriteChain: Promise<void> = Promise.resolve();
  private readonly pendingOperations = new Map<string, {
    operation: UpstreamWorkerOperation;
    submitted: Record<string, unknown>;
    expiresAt: number;
  }>();

  constructor(
    private readonly config: AppConfig,
    private readonly reads: Sub2ApiReadClient,
    private readonly temporal: TemporalGateway | null = null,
    private readonly runtime: Sub2ApiRuntimeService | null = null,
    private readonly probeIsolation: ProbeIsolationService | null = null,
  ) {}

  private readLedger(): UpstreamRechargeCostEntry[] {
    return readUpstreamRechargeCosts(this.config.operations.upstreamRechargeLedgerPath);
  }

  private async recordRecharge(input: {
    operationId: string;
    account: UpstreamAccount;
    amountCny: number;
    description?: string;
  }): Promise<Record<string, unknown>> {
    const run = this.ledgerWriteChain.then(() => recordUpstreamRechargeCost({
      path: this.config.operations.upstreamRechargeLedgerPath,
      operationId: input.operationId,
      occurredOn: new Date().toLocaleDateString("sv-SE", { timeZone: this.config.monitor.timezone }),
      accountId: input.account.id,
      accountName: input.account.name,
      baseUrl: input.account.baseUrl,
      suffix: input.account.suffix ?? "unknown",
      rateCnyPerApiUsd: input.account.rateCnyPerApiUsd ?? 0.0,
      amountCny: input.amountCny,
      description: input.description,
    }));
    this.ledgerWriteChain = run.then(() => undefined, () => undefined);
    const result = await run;
    return {
      currency: result.currency,
      mutation: result.mutation,
      operationId: result.entry.operationId,
      entryId: result.entry.id,
      accountId: result.entry.accountId,
      amountCny: result.entry.amountCny,
      pathPrinted: false,
    };
  }

  options(): Record<string, unknown> {
    const settings = this.config.operations.upstreamManagement;
    return {
      ok: true,
      defaults: {
        priority: settings.priority,
        capacity: settings.capacity,
        groupIds: [...settings.groupIds],
      },
      groups: [
        { id: 2, name: "混合池" },
        { id: 3, name: "自用" },
        { id: 6, name: "Grok" },
      ],
      valuation: readUpstreamValuationPolicy(this.config.operations.ledgerYamlPath),
      benchmark: {
        enabled: this.config.operations.upstreamBenchmark.enabled,
        provider: this.config.operations.upstreamBenchmark.provider,
        benchmarkVersion: this.config.operations.upstreamBenchmark.benchmarkVersion,
        model: this.config.operations.upstreamBenchmark.model,
      },
      valuesRedacted: true,
    };
  }

  private prunePendingOperations(): void {
    const now = Date.now();
    for (const [id, entry] of this.pendingOperations) {
      if (entry.expiresAt <= now) this.pendingOperations.delete(id);
    }
  }

  private async submitOperation(
    operationIdValue: string,
    operation: UpstreamWorkerOperation,
  ): Promise<Record<string, unknown>> {
    this.prunePendingOperations();
    const previous = this.pendingOperations.get(operationIdValue);
    if (previous) return { ...previous.submitted };
    if (!this.temporal) throw new UpstreamManagementError("Temporal worker 当前不可用", 503, { operation: operation.action });
    const submitted = await this.temporal.submit({ kind: "upstream.operation", operationId: operationIdValue });
    const result: Record<string, unknown> = {
      ...submitted,
      ok: true,
      operation: "submitted",
      action: operation.action,
      operationId: operationIdValue,
    };
    this.pendingOperations.set(operationIdValue, {
      operation,
      submitted: result,
      expiresAt: Date.now() + 30 * 60_000,
    });
    return result;
  }

  private createInput(input: {
    baseUrl: string;
    apiKey: string;
    suffix: string;
    rateCnyPerApiUsd?: unknown;
    rechargeCny?: unknown;
    priority?: unknown;
    capacity?: unknown;
    groupIds?: unknown;
    operationId?: string | null;
    description?: string;
  }): UpstreamCreateInput {
    const settings = this.config.operations.upstreamManagement;
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const suffix = validateSuffix(input.suffix);
    const rateWasSpecified = !(
      input.rateCnyPerApiUsd === undefined
      || input.rateCnyPerApiUsd === null
      || input.rateCnyPerApiUsd === ""
    );
    const rateCnyPerApiUsd = validateRate(
      !rateWasSpecified
        ? settings.createBootstrapRateCnyPerApiUsd
        : input.rateCnyPerApiUsd,
    );
    const apiKey = input.apiKey.trim();
    if (!/^sk-[A-Za-z0-9_=+/.-]{16,}$/u.test(apiKey)) throw new Error("API key 格式无效");
    const rechargeCny = input.rechargeCny === undefined || input.rechargeCny === null || input.rechargeCny === ""
      ? null : validateRecharge(input.rechargeCny);
    const priority = input.priority === undefined || input.priority === null || input.priority === ""
      ? settings.priority : validatePriority(input.priority);
    const capacity = input.capacity === undefined || input.capacity === null || input.capacity === ""
      ? settings.capacity : validateCapacity(input.capacity);
    const groupIds = input.groupIds === undefined || input.groupIds === null
      ? [...settings.groupIds] : validateGroupIds(input.groupIds);
    return {
      baseUrl,
      apiKey,
      suffix,
      rateCnyPerApiUsd,
      rateWasSpecified,
      rechargeCny,
      priority,
      capacity,
      groupIds,
      operationId: operationId(input.operationId, "upstream-create"),
      description: input.description,
    };
  }

  async submitCreate(input: Parameters<UpstreamManagementService["create"]>[0] & {
    operationId?: string | null;
  }): Promise<Record<string, unknown>> {
    const prepared = this.createInput(input);
    return await this.submitOperation(prepared.operationId, { action: "create", input: prepared });
  }

  async submitUpdate(id: number, input: {
    suffix?: unknown;
    rateCnyPerApiUsd?: unknown;
    operationId?: string | null;
  }): Promise<Record<string, unknown>> {
    if (!positiveInteger(id)) throw new Error("上游账号 ID 无效");
    const suffix = input.suffix === undefined ? undefined : validateSuffix(String(input.suffix));
    const rateCnyPerApiUsd = input.rateCnyPerApiUsd === undefined ? undefined : validateRate(input.rateCnyPerApiUsd);
    const idempotency = operationId(input.operationId, `upstream-update-${id}`);
    return await this.submitOperation(idempotency, {
      action: "update",
      input: { id, suffix, rateCnyPerApiUsd },
    });
  }

  async submitRecharge(id: number, input: {
    amountCny: unknown;
    operationId?: string | null;
    description?: string;
  }): Promise<Record<string, unknown>> {
    if (!positiveInteger(id)) throw new Error("上游账号 ID 无效");
    const amountCny = validateRecharge(input.amountCny);
    const idempotency = operationId(input.operationId, `upstream-recharge-${id}`);
    return await this.submitOperation(idempotency, {
      action: "recharge",
      input: { id, amountCny, operationId: idempotency, description: input.description },
    });
  }

  async submitUsage(accountIds: number[], operationIdValue?: string | null): Promise<Record<string, unknown>> {
    const ids = [...new Set(accountIds.map(Number))];
    if (ids.some((id) => !positiveInteger(id))) throw new Error("上游账号 ID 无效");
    const idempotency = operationId(operationIdValue, "upstream-usage");
    return await this.submitOperation(idempotency, { action: "usage", input: { accountIds: ids } });
  }

  async submitTemplate(accountIds: number[], operationIdValue?: string | null): Promise<Record<string, unknown>> {
    const ids = [...new Set(accountIds.map(Number))];
    if (ids.some((id) => !positiveInteger(id))) throw new Error("上游账号 ID 无效");
    const idempotency = operationId(operationIdValue, "upstream-template");
    return await this.submitOperation(idempotency, { action: "template", input: { accountIds: ids } });
  }

  async submitIsolation(accountIds: number[], operationIdValue?: string | null): Promise<Record<string, unknown>> {
    const ids = [...new Set(accountIds.map(Number))];
    if (ids.length === 0 || ids.some((id) => !positiveInteger(id))) {
      throw new Error("上游隔离需要至少一个有效账号 ID");
    }
    const idempotency = operationId(operationIdValue, "upstream-isolation");
    return await this.submitOperation(idempotency, { action: "isolation", input: { accountIds: ids } });
  }

  claimOperation(id: string): UpstreamWorkerOperation | null {
    this.prunePendingOperations();
    return this.pendingOperations.get(id)?.operation ?? null;
  }

  completeOperation(id: string): Record<string, unknown> {
    const deleted = this.pendingOperations.delete(id);
    return { ok: true, operationId: id, released: deleted, valuesPrinted: false };
  }

  async workflowStatus(id: string): Promise<Record<string, unknown>> {
    if (!this.temporal) throw new UpstreamManagementError("Temporal worker 当前不可用", 503, { operation: "status" });
    return await this.temporal.status(id);
  }

  private async accountQuery(id: number): Promise<UpstreamAccount | null> {
    const query = await this.reads.query<Row>({
      key: `upstream-account:${id}`,
      kind: "upstream-account",
      priority: "manual",
      cacheMode: "bypass-cache",
      sql: `${accountSelect}
        WHERE a.deleted_at IS NULL
          AND LOWER(a.type) = 'apikey'
          AND NULLIF(a.credentials->>'base_url', '') IS NOT NULL
          AND a.id = $1::bigint
        GROUP BY a.id
        LIMIT 1`,
      parameters: [id],
    });
    const row = query.rows[0];
    if (!row) return null;
    const entries = this.readLedger();
    return rowToAccount(row, rechargeTotalsByAccount(entries), entries);
  }

  private async accountQueryByIdentity(name: string, baseUrl: string): Promise<UpstreamAccount | null> {
    const suffix = parseUpstreamName(name, baseUrl)?.suffix ?? "";
    const query = await this.reads.query<Row>({
      key: `upstream-account-identity:${name}:${baseUrl}`,
      kind: "upstream-account-identity",
      priority: "manual",
      cacheMode: "bypass-cache",
      sql: `${accountSelect}
        WHERE a.deleted_at IS NULL
          AND LOWER(a.type) = 'apikey'
          AND (
            a.name = $1::text
            OR ($3::text <> '' AND a.name LIKE RTRIM($2::text, '/') || ' ' || $3::text || ' %')
          )
          AND RTRIM(COALESCE(a.credentials->>'base_url', ''), '/') = RTRIM($2::text, '/')
        GROUP BY a.id
        ORDER BY a.id DESC
        LIMIT 1`,
      parameters: [name, baseUrl, suffix],
    });
    const row = query.rows[0];
    if (!row) return null;
    const entries = this.readLedger();
    return rowToAccount(row, rechargeTotalsByAccount(entries), entries);
  }

  private async walletAccounts(baseUrl: string): Promise<UpstreamAccount[]> {
    const query = await this.reads.query<Row>({
      key: `upstream-wallet-accounts:${normalizeUpstreamWallet(baseUrl)}`,
      kind: "upstream-wallet-accounts",
      priority: "manual",
      cacheMode: "bypass-cache",
      sql: `${accountSelect}
        WHERE a.deleted_at IS NULL
          AND LOWER(a.type) = 'apikey'
          AND NULLIF(a.credentials->>'base_url', '') IS NOT NULL
          AND RTRIM(a.credentials->>'base_url', '/') = RTRIM($1::text, '/')
        GROUP BY a.id
        ORDER BY a.id`,
      parameters: [normalizeUpstreamWallet(baseUrl)],
    });
    const wallet = normalizeUpstreamWallet(baseUrl);
    const entries = this.readLedger();
    const totals = rechargeTotalsByAccount(entries);
    return query.rows
      .map((row) => rowToAccount(row, totals, entries))
      .filter((candidate) => normalizeUpstreamWallet(candidate.baseUrl) === wallet);
  }

  private async resolveCreatedAccount(
    accountId: number | null,
    name: string,
    baseUrl: string,
  ): Promise<UpstreamAccount | null> {
    const direct = accountId === null ? null : await this.accountQuery(accountId);
    if (direct) return direct;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const byIdentity = await this.accountQueryByIdentity(name, baseUrl);
      if (byIdentity) return byIdentity;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return null;
  }

  async list(page: number, search: string | null): Promise<Record<string, unknown>> {
    const pageSize = this.config.operations.upstreamManagement.pageSize;
    const normalizedSearch = searchValue(search);
    const offset = (page - 1) * pageSize;
    const query = await this.reads.query<Row>({
      key: `upstreams:${page}:${normalizedSearch.toLowerCase()}`,
      kind: "upstreams-page",
      priority: "manual",
      cacheMode: "bypass-cache",
      sql: `${accountSelect}
        WHERE a.deleted_at IS NULL
          AND LOWER(a.type) = 'apikey'
          AND NULLIF(a.credentials->>'base_url', '') IS NOT NULL
          AND (
            $1::text = ''
            OR a.id::text ILIKE '%' || $1::text || '%'
            OR a.name ILIKE '%' || $1::text || '%'
            OR a.credentials->>'base_url' ILIKE '%' || $1::text || '%'
            OR a.status ILIKE '%' || $1::text || '%'
            OR CASE
              WHEN a.status = 'active' AND COALESCE(a.schedulable, false) THEN '可调度'
              WHEN a.status = 'active' THEN '已停调度'
              ELSE '异常'
            END ILIKE '%' || $1::text || '%'
            OR a.schedulable::text ILIKE '%' || $1::text || '%'
            OR LEFT(a.credentials->>'api_key', 8) ILIKE '%' || $1::text || '%'
          )
        GROUP BY a.id
        ORDER BY a.id DESC
        LIMIT $2::int OFFSET $3::int`,
      parameters: [normalizedSearch, pageSize, offset],
    });
    const total = Number(query.rows[0]?.total_count ?? 0);
    const availableTotal = Number(query.rows[0]?.available_count ?? 0);
    const entries = this.readLedger();
    const totals = rechargeTotalsByAccount(entries);
    const accounts = query.rows.map((row) => rowToAccount(row, totals, entries));
    return {
      ok: true,
      page,
      pageSize,
      search: normalizedSearch,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      availableTotal,
      rechargeTotalCny: rechargeTotal(entries),
      rechargeCount: entries.length,
      accounts,
      databaseQueries: query.cached ? 0 : 1,
      queueDurationMs: query.queueDurationMs,
      queryDurationMs: query.queryDurationMs,
    };
  }

  async usage(accountIds: number[]): Promise<Record<string, unknown>> {
    const settings = this.config.operations.upstreamManagement;
    const query = await this.reads.query<Row>({
      key: `upstream-usage-targets:${accountIds.length ? accountIds.join(",") : "all"}`,
      kind: "upstream-usage-targets",
      priority: "manual",
      cacheMode: "bypass-cache",
      sql: `WITH targets AS (
        SELECT
          a.id,
          a.name,
          RTRIM(COALESCE(a.credentials->>'base_url', ''), '/') AS base_url,
          COALESCE(a.credentials->>'api_key', '') AS api_key,
          a.status,
          COALESCE(a.schedulable, false) AS schedulable,
          COALESCE(SUM(usage.actual_cost), 0)::numeric AS account_api_amount_usd_total
        FROM accounts a
        LEFT JOIN usage_logs usage ON usage.account_id = a.id
        WHERE a.deleted_at IS NULL
          AND LOWER(a.type) = 'apikey'
          AND NULLIF(a.credentials->>'base_url', '') IS NOT NULL
          AND NULLIF(a.credentials->>'api_key', '') IS NOT NULL
          AND ($1::text = '' OR a.id = ANY(string_to_array($1::text, $2::text)::bigint[]))
        GROUP BY a.id
      )
      SELECT targets.*,
        SUM(account_api_amount_usd_total) OVER()::numeric AS api_amount_usd_total
      FROM targets
      ORDER BY id`,
      parameters: [accountIds.join(","), ","],
    });
    const targets = query.rows.map((item): UpstreamUsageTarget => ({
      id: Number(item.id),
      name: String(item.name ?? ""),
      baseUrl: normalizeBaseUrl(String(item.base_url ?? "")),
      apiKey: String(item.api_key ?? ""),
      status: String(item.status ?? "unknown"),
      schedulable: item.schedulable === true,
      apiAmountUsdTotal: Number(item.account_api_amount_usd_total ?? 0),
    }));
    const results = await queryUpstreamUsageConcurrently(targets, {
      concurrency: settings.usageConcurrency,
      timeoutMs: settings.usageTimeoutMs,
      days: settings.usageDays,
    });
    return {
      ok: true,
      operation: "usage",
      requestedAccountIds: accountIds,
      targetCount: targets.length,
      succeeded: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      providers: {
        sub2api: results.filter((result) => result.provider === "sub2api").length,
        newApi: results.filter((result) => result.provider === "new-api").length,
        unknown: results.filter((result) => result.provider === "unknown").length,
      },
      databaseQueries: query.cached ? 0 : 1,
      queueDurationMs: query.queueDurationMs,
      queryDurationMs: query.queryDurationMs,
      upstreamConcurrency: settings.usageConcurrency,
      apiAmountUsdTotal: Number(query.rows[0]?.api_amount_usd_total ?? 0),
      results,
      valuesRedacted: true,
    };
  }

  async synchronizeDetectedRates(results: UpstreamUsageResult[], options: {
    fallbackRateCnyPerApiUsd?: number;
  } = {}): Promise<Record<string, unknown>> {
    if (!this.runtime) throw new Error("Api2Business Sub2API runtime mutation service 不可用");
    const policy = readUpstreamValuationPolicy(this.config.operations.ledgerYamlPath);
    const synchronized: number[] = [];
    const alreadySynchronized: number[] = [];
    const retained: Array<{ accountId: number; reason: string }> = [];
    const failed: Array<{ accountId: number; error: string }> = [];
    const fallbackRate = options.fallbackRateCnyPerApiUsd === undefined
      ? null
      : validateRate(options.fallbackRateCnyPerApiUsd);
    for (const result of results) {
      const multiplier = Number(result.billingMultiplier.value);
      const parsed = parseUpstreamName(result.accountName, result.baseUrl) ?? parseUpstreamNameTail(result.accountName);
      if (result.billingMultiplier.value == null || !Number.isFinite(multiplier) || multiplier <= 0) {
        if (fallbackRate !== null && parsed) {
          try {
            const name = formatUpstreamName(result.baseUrl, parsed.suffix, fallbackRate);
            await this.runtime.updateAccount(result.accountId, { name });
            const readback = await this.accountQuery(result.accountId);
            if (!readback || readback.name !== name || readback.rateCnyPerApiUsd === null
              || Math.abs(readback.rateCnyPerApiUsd - fallbackRate) > 0.0000005) {
              throw new Error("探测失败回退费率写入后排队回读不一致");
            }
            result.billingMultiplier.synchronizedRateCnyPerApiUsd = fallbackRate;
            result.billingMultiplier.syncStatus = "synchronized";
            result.billingMultiplier.syncMessage = `未取得有效正倍率，已回退为 ${formatRate(fallbackRate)} 元/刀`;
            synchronized.push(result.accountId);
            continue;
          } catch (error) {
            failed.push({ accountId: result.accountId, error: safeMessage(error instanceof Error ? error.message : String(error)) });
          }
        }
        result.billingMultiplier.syncStatus = "retained-manual";
        result.billingMultiplier.syncMessage = fallbackRate === null
          ? "未取得有效正倍率，保留手工费率"
          : "未取得有效正倍率，回退费率写入失败，保留当前费率";
        retained.push({ accountId: result.accountId, reason: "invalid-or-missing-multiplier" });
        continue;
      }
      if (!parsed) {
        result.billingMultiplier.syncStatus = "retained-manual";
        result.billingMultiplier.syncMessage = "账号名称缺少可保留的后缀，未自动改名";
        retained.push({ accountId: result.accountId, reason: "unparseable-account-suffix" });
        continue;
      }
      const wallet = normalizeUpstreamWallet(result.baseUrl);
      const walletRate = upstreamBalanceRateByWallet(wallet, policy.defaultCnyPerApiUsd, policy.walletCnyPerApiUsd);
      const detectedRate = Number(formatRate(multiplier * walletRate));
      result.billingMultiplier.previousManualRateCnyPerApiUsd = parsed.rateCnyPerApiUsd;
      result.billingMultiplier.synchronizedRateCnyPerApiUsd = detectedRate;
      if (Math.abs(parsed.rateCnyPerApiUsd - detectedRate) <= 0.0000005) {
        result.billingMultiplier.syncStatus = "already-synchronized";
        result.billingMultiplier.syncMessage = "手工费率已与探测成本一致";
        alreadySynchronized.push(result.accountId);
        continue;
      }
      try {
        const name = formatUpstreamName(result.baseUrl, parsed.suffix, detectedRate);
        await this.runtime.updateAccount(result.accountId, { name });
        const readback = await this.accountQuery(result.accountId);
        if (!readback || readback.name !== name || readback.rateCnyPerApiUsd === null
          || Math.abs(readback.rateCnyPerApiUsd - detectedRate) > 0.0000005) {
          throw new Error("探测费率写入后排队回读不一致");
        }
        result.billingMultiplier.syncStatus = "synchronized";
        result.billingMultiplier.syncMessage = `已从 ${formatRate(parsed.rateCnyPerApiUsd)} 同步为 ${formatRate(detectedRate)} 元/刀`;
        synchronized.push(result.accountId);
      } catch (error) {
        const message = safeMessage(error instanceof Error ? error.message : String(error));
        result.billingMultiplier.syncStatus = "failed";
        result.billingMultiplier.syncMessage = message;
        failed.push({ accountId: result.accountId, error: message });
      }
    }
    return {
      attempted: results.length,
      synchronizedCount: synchronized.length,
      alreadySynchronizedCount: alreadySynchronized.length,
      retainedCount: retained.length,
      failedCount: failed.length,
      synchronized,
      alreadySynchronized,
      retained,
      failed,
      valuesRedacted: true,
    };
  }

  async applyTemplate(accountIds: number[]): Promise<Record<string, unknown>> {
    if (!this.runtime) throw new Error("Api2Business Sub2API runtime mutation service 不可用");
    const query = await this.reads.query<Row>({
      key: `upstream-template-targets:${accountIds.length ? accountIds.join(",") : "all"}`,
      kind: "upstream-template-targets",
      priority: "manual",
      cacheMode: "bypass-cache",
      sql: `SELECT a.id
        FROM accounts a
        WHERE a.deleted_at IS NULL
          AND LOWER(a.type) = 'apikey'
          AND NULLIF(a.credentials->>'base_url', '') IS NOT NULL
          AND ($1::text = '' OR a.id = ANY(string_to_array($1::text, $2::text)::bigint[]))
        ORDER BY a.id`,
      parameters: [accountIds.join(","), ","],
    });
    const ids = query.rows.map((item) => Number(item.id)).filter((id) => positiveInteger(id) !== null);
    const applied = ids;
    const failed: Array<{ accountId: number; error: string }> = [];
    try {
      await this.runtime.applyApiKeyFailoverTemplates(ids, this.config.operations.upstreamManagement.mutationTimeoutMs);
    } catch (error) {
      failed.push(...ids.map((accountId) => ({ accountId, error: safeMessage(error instanceof Error ? error.message : String(error)) })));
    }
    const verify = applied.length ? await this.reads.query<Row>({
      key: `upstream-template-verify:${applied.join(",")}`,
      kind: "upstream-template-verify",
      priority: "manual",
      cacheMode: "bypass-cache",
      sql: `SELECT id,
          COALESCE((credentials->>'pool_mode')::boolean, true) AS pool_mode,
          COALESCE((credentials->>'temp_unschedulable_enabled')::boolean, false) AS temp_enabled,
          COALESCE(credentials->'temp_unschedulable_rules', '[]'::jsonb) AS temp_rules
        FROM accounts
        WHERE deleted_at IS NULL
          AND id = ANY(string_to_array($1::text, $2::text)::bigint[])
        ORDER BY id`,
      parameters: [applied.join(","), ","],
    }) : null;
    const expectedRules = this.config.operations.upstreamManagement.failoverRules;
    const verified: number[] = [];
    const misaligned: Array<{
      accountId: number;
      reason: string;
      poolMode?: unknown;
      tempEnabled?: unknown;
      ruleCount?: number;
      rulesAligned?: boolean;
    }> = [];
    for (const row of verify?.rows ?? []) {
      const accountId = Number(row.id);
      const rawRules = typeof row.temp_rules === "string" ? (() => {
        try { return JSON.parse(row.temp_rules) as unknown; } catch { return []; }
      })() : row.temp_rules;
      const rulesAligned = canonicalJson(rawRules) === canonicalJson(expectedRules);
      if (row.pool_mode === false && row.temp_enabled === true && rulesAligned) verified.push(accountId);
      else misaligned.push({
        accountId,
        reason: "runtime-template-readback-mismatch",
        poolMode: row.pool_mode,
        tempEnabled: row.temp_enabled,
        ruleCount: Array.isArray(rawRules) ? rawRules.length : 0,
        rulesAligned,
      });
    }
    for (const accountId of applied) {
      if (!verified.includes(accountId) && !misaligned.some((item) => item.accountId === accountId)) {
        misaligned.push({ accountId, reason: "runtime-account-missing-from-readback" });
      }
    }
    return {
      ok: failed.length === 0 && misaligned.length === 0,
      operation: "template",
      requestedAccountIds: accountIds,
      targetCount: ids.length,
      appliedCount: applied.length,
      failedCount: failed.length,
      verifiedCount: verified.length,
      misalignedCount: misaligned.length,
      applied,
      failed,
      verified,
      misaligned,
      databaseQueries: (query.cached ? 0 : 1) + (verify?.cached ? 0 : verify ? 1 : 0),
      queueDurationMs: query.queueDurationMs + (verify?.queueDurationMs ?? 0),
      queryDurationMs: query.queryDurationMs + (verify?.queryDurationMs ?? 0),
      valuesRedacted: true,
    };
  }

  async ensureProbeIsolation(accountIds: number[]): Promise<Record<string, unknown>> {
    if (!this.probeIsolation) throw new Error("Api2Business 上游探活隔离服务不可用");
    const requested = [...new Set(accountIds.map(Number))].sort((left, right) => left - right);
    if (requested.length === 0 || requested.some((accountId) => !positiveInteger(accountId))) {
      throw new Error("上游隔离需要至少一个有效账号 ID");
    }
    const query = await this.reads.query<Row>({
      key: `upstream-isolation-targets:${requested.join(",")}`,
      kind: "upstream-isolation-targets",
      priority: "manual",
      cacheMode: "bypass-cache",
      sql: `SELECT id
        FROM accounts
        WHERE deleted_at IS NULL
          AND LOWER(type) = 'apikey'
          AND id = ANY(string_to_array($1::text, $2::text)::bigint[])
        ORDER BY id`,
      parameters: [requested.join(","), ","],
    });
    const targets = query.rows.map((item) => Number(item.id)).filter(positiveInteger);
    const completed: Array<{ accountId: number; groupId: number; keyCreated: boolean }> = [];
    const failed: Array<{ accountId: number; error: string }> = requested
      .filter((accountId) => !targets.includes(accountId))
      .map((accountId) => ({ accountId, error: "账号不存在或不是 API-key 上游" }));
    for (const accountId of targets) {
      try {
        const binding = await this.probeIsolation.ensure(accountId);
        completed.push({ accountId, groupId: binding.groupId, keyCreated: binding.keyCreated });
      } catch (error) {
        failed.push({ accountId, error: safeMessage(error instanceof Error ? error.message : String(error)) });
      }
    }
    return {
      ok: failed.length === 0,
      operation: "probe-isolation",
      requestedAccountIds: requested,
      targetCount: targets.length,
      completedCount: completed.length,
      failedCount: failed.length,
      completed,
      failed,
      databaseQueries: query.cached ? 0 : 1,
      queueDurationMs: query.queueDurationMs,
      queryDurationMs: query.queryDurationMs,
      valuesRedacted: true,
    };
  }

  async create(input: {
    baseUrl: string;
    apiKey: string;
    suffix: string;
    rateCnyPerApiUsd: unknown;
    rateWasSpecified: boolean;
    rechargeCny?: unknown;
    priority?: unknown;
    capacity?: unknown;
    groupIds?: unknown;
    operationId?: string | null;
    description?: string;
  }): Promise<Record<string, unknown>> {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const suffix = validateSuffix(input.suffix);
    const rate = validateRate(input.rateCnyPerApiUsd);
    if (!/^sk-[A-Za-z0-9_=+/.-]{16,}$/u.test(input.apiKey.trim())) throw new Error("API key 格式无效");
    const recharge = input.rechargeCny === undefined || input.rechargeCny === null || input.rechargeCny === ""
      ? null : validateRecharge(input.rechargeCny);
    const name = formatUpstreamName(baseUrl, suffix, rate);
    const settings = this.config.operations.upstreamManagement;
    const priority = input.priority === undefined || input.priority === null || input.priority === ""
      ? settings.priority : validatePriority(input.priority);
    const capacity = input.capacity === undefined || input.capacity === null || input.capacity === ""
      ? settings.capacity : validateCapacity(input.capacity);
    const groupIds = input.groupIds === undefined || input.groupIds === null
      ? [...settings.groupIds] : validateGroupIds(input.groupIds);
    const target = this.config.monitor.target;
    let createResult: Row | null = null;
    let createError: unknown = null;
    let account = await this.accountQueryByIdentity(name, baseUrl);
    let recovered = account !== null;
    if (account && recharge === null) {
      const existingProbe = this.probeIsolation?.get(account.id) ?? null;
      const expectedGroups = existingProbe
        ? [...new Set([...groupIds, existingProbe.groupId])].sort((left, right) => left - right)
        : [];
      const actualGroups = [...account.groupIds].sort((left, right) => left - right);
      if (input.rateWasSpecified && existingProbe && account.priority === priority && account.capacity === capacity
        && account.proxyId === settings.proxyId
        && JSON.stringify(actualGroups) === JSON.stringify(expectedGroups)) {
        return {
          ok: true,
          operation: "create-recovered",
          recovered: true,
          account,
          idempotentFastPath: true,
          skipDetection: true,
          accounting: null,
          warnings: [],
        };
      }
    }
    if (!account) {
      if (!this.runtime) throw new Error("Api2Business Sub2API runtime mutation service 不可用");
      try {
        const result = await this.runtime.createApiKeyAccount({
          name, platform: "openai", type: "apikey",
          credentials: { base_url: baseUrl, api_key: input.apiKey.trim() },
          extra: {}, priority, concurrency: capacity, proxy_id: settings.proxyId,
          group_ids: groupIds, auto_pause_on_expired: true, schedulable: true,
        }, operationId(input.operationId, `upstream-create-${name.replace(/[^A-Za-z0-9]+/gu, "-").slice(0, 48)}`), settings.mutationTimeoutMs);
        createResult = result;
      } catch (error) {
        if (isAlreadyExistsError(error)) recovered = true;
        else createError = error;
      }
    }
    const accountId = findAccountId(createResult) ?? account?.id ?? null;
    account = await this.resolveCreatedAccount(accountId, name, baseUrl);
    if (!account) {
      if (createError !== null) throw createError;
      throw new UpstreamManagementError(
        recovered || createResult !== null
          ? "runtime 已创建或已存在账号，但排队回读未找到稳定账号 ID；请勿重复创建，稍后从上游列表重试"
          : "runtime 创建失败且排队回读未找到同名账号",
        502,
        { operation: "create", partial: recovered || createResult !== null },
      );
    }
    if (createError !== null) recovered = true;
    const resolvedAccountId = account.id;
    // 创建终态只依赖稳定账号 ID；探活隔离、运行设置和模板在后台尽力完成，
    // 避免 Sub2API 后处理超时把已经创建成功的账号伪装成导入失败。
    const postProcess = async () => {
      try {
        if (!this.probeIsolation) throw new Error("探活隔离服务不可用");
        const probeBinding = this.probeIsolation.get(resolvedAccountId)
          ?? await this.probeIsolation.ensure(resolvedAccountId);
        const effectiveGroupIds = [...new Set([...groupIds, probeBinding.groupId])];
        const desiredGroupIds = [...effectiveGroupIds].sort((left, right) => left - right);
        const actualGroupIds = [...account.groupIds].sort((left, right) => left - right);
        if (!this.runtime) throw new Error("Sub2API runtime mutation service 不可用");
        const needsRuntimeSettings = account.priority !== priority || account.capacity !== capacity
          || account.proxyId !== settings.proxyId || JSON.stringify(actualGroupIds) !== JSON.stringify(desiredGroupIds);
        // Sub2API 原生批量更新同时写运行参数和切号模板，避免创建流程产生两次远程 mutation。
        await this.runtime.configureApiKeyAccounts(
          [resolvedAccountId],
          {
            ...(needsRuntimeSettings ? { priority, concurrency: capacity, group_ids: effectiveGroupIds, proxy_id: settings.proxyId } : {}),
            credentials: {
              pool_mode: false,
              temp_unschedulable_enabled: true,
              temp_unschedulable_rules: this.config.operations.upstreamManagement.failoverRules,
            },
          },
          settings.mutationTimeoutMs,
        );
      } catch (error) {
        console.warn(`[upstream-create:${resolvedAccountId}] 后处理未完成：${safeMessage(error instanceof Error ? error.message : String(error))}`);
      }
    };
    await postProcess();
    let accounting: Record<string, unknown> | null = null;
    if (recharge !== null) {
      try {
        accounting = await this.recordRecharge({
          operationId: operationId(input.operationId, `upstream-create-${resolvedAccountId}`),
          account,
          amountCny: recharge,
          description: input.description,
        });
      } catch (error) {
        throw new UpstreamManagementError(
          `账号已创建，但人民币充值记账失败：${error instanceof Error ? error.message : String(error)}`,
          500,
          { operation: "accounting", partial: true, accountId: resolvedAccountId },
        );
      }
      const refreshed = await this.accountQuery(resolvedAccountId);
      if (!refreshed) throw new UpstreamManagementError("充值记账完成但排队查询未找到账号", 502, {
        operation: "create", partial: true, accountId: resolvedAccountId, accounting,
      });
      account = refreshed;
    }
    return {
      ok: true,
      operation: recovered ? "create-recovered" : "create",
      recovered,
      account,
      template: { applied: false, verified: false, status: "pending" },
      probeIsolation: { enabled: false, status: "pending" },
      warnings: ["探活隔离与运行设置已完成；返回账号快照可能早于最终倍率探测回写"],
      accounting,
    };
  }

  async update(id: number, input: {
    suffix?: unknown;
    rateCnyPerApiUsd?: unknown;
  }): Promise<Record<string, unknown>> {
    const account = await this.accountQuery(id);
    if (!account) throw new UpstreamManagementError("上游账号不存在", 404, { operation: "update", accountId: id });
    if (!this.runtime) throw new Error("Api2Business Sub2API runtime mutation service 不可用");
    let name: string | undefined;
    if (input.suffix !== undefined || input.rateCnyPerApiUsd !== undefined) {
      const suffix = input.suffix === undefined ? account.suffix : validateSuffix(String(input.suffix));
      const rate = input.rateCnyPerApiUsd === undefined ? account.rateCnyPerApiUsd : validateRate(input.rateCnyPerApiUsd);
      if (!suffix || rate === null) throw new Error("当前账号缺少可解析的后缀或费率，请同时填写后缀和费率");
      name = formatUpstreamName(account.baseUrl, suffix, rate);
    }
    // 名称和切号模板一次性写入，避免更新费率时产生两次远程 mutation。
    await this.runtime.configureApiKeyAccounts([id], {
      ...(name && name !== account.name ? { name } : {}),
      credentials: {
        pool_mode: false,
        temp_unschedulable_enabled: true,
        temp_unschedulable_rules: this.config.operations.upstreamManagement.failoverRules,
      },
    }, this.config.operations.upstreamManagement.mutationTimeoutMs);
    const updated = await this.accountQuery(id);
    if (!updated) throw new UpstreamManagementError("runtime 改名完成但排队查询未找到账号", 502, { operation: "update", accountId: id });
    return { ok: true, operation: "update", account: updated };
  }

  async recharge(id: number, input: {
    amountCny: unknown;
    operationId?: string | null;
    description?: string;
  }): Promise<Record<string, unknown>> {
    const amountCny = validateRecharge(input.amountCny);
    let account = await this.accountQuery(id);
    if (!account) throw new UpstreamManagementError("上游账号不存在", 404, { operation: "recharge", accountId: id });
    const accounting = await this.recordRecharge({
      operationId: operationId(input.operationId, `upstream-recharge-${id}`),
      account,
      amountCny,
      description: input.description,
    });
    const walletAccounts = await this.walletAccounts(account.baseUrl);
    const recoveryTargets = walletAccounts.filter((candidate) => candidate.status !== "active" || !candidate.schedulable);
    const recoveredAccountIds: number[] = [];
    const recoveryErrors: string[] = [];
    if (recoveryTargets.length && !this.runtime) throw new UpstreamManagementError(
      "充值已记账，但 Api2Business Sub2API runtime mutation service 不可用",
      502,
      { operation: "recovery", partial: true, accountId: id, accounting },
    );
    if (recoveryTargets.length) {
      try {
        await this.runtime!.recoverAccounts(
          recoveryTargets.map((candidate) => candidate.id),
          this.config.operations.upstreamManagement.mutationTimeoutMs,
        );
        recoveredAccountIds.push(...recoveryTargets.map((candidate) => candidate.id));
      } catch (error) {
        recoveryErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (recoveryErrors.length) throw new UpstreamManagementError(
      `充值已记账，同源账号部分恢复失败：${recoveryErrors.join("；")}`,
      502,
      { operation: "recovery", partial: true, accountId: id, accounting },
    );
    const refreshed = await this.accountQuery(id);
    if (!refreshed) throw new UpstreamManagementError("充值完成但排队查询未找到账号", 502, {
      operation: "recharge", partial: true, accountId: id, accounting,
    });
    account = refreshed;
    return {
      ok: true,
      operation: "recharge",
      account,
      accounting,
      recovered: recoveredAccountIds.length > 0,
      recoveredAccountIds,
      walletAccountIds: walletAccounts.map((candidate) => candidate.id),
    };
  }
}
