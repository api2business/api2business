import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "./config";
import type { Paginated, Sub2ApiClient } from "./sub2api-client";
import type { Sub2ApiRuntimeService } from "./sub2api-runtime-service";

type Row = Record<string, unknown>;

interface ProbeKeyRecord {
  accountId: number;
  groupId: number;
  userId: number;
  email: string;
  password: string;
  apiKey: string;
  ready?: boolean;
  policyVersion?: number;
}

interface MonitorUserRecord {
  userId: number;
  email: string;
  password: string;
  funded: boolean;
}

interface ProbeKeyFile {
  version: 1;
  monitor?: MonitorUserRecord;
  records: Record<string, ProbeKeyRecord>;
}

const MONITOR_EMAIL = "monitor-user@sub2api.platform-infra.local";
const MONITOR_USERNAME = "monitor-user";
const POLICY_VERSION = 3;

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function id(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function generatedSecret(prefix: string): string {
  return `${prefix}${randomBytes(24).toString("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError"
    || error instanceof Error && /timed out|timeout/iu.test(error.message);
}

function pageItems(value: unknown): Row[] {
  const data = row(value) as Partial<Paginated<Row>>;
  return Array.isArray(data.items) ? data.items.map(row) : [];
}

function ids(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => id(item)).filter((value): value is number => value !== null);
}

function accountGroupIds(account: Row): number[] {
  const direct = ids(account.group_ids);
  const joins = Array.isArray(account.account_groups)
    ? account.account_groups.map((item) => id(row(item).group_id)).filter((value): value is number => value !== null)
    : [];
  const groups = Array.isArray(account.groups)
    ? account.groups.map((item) => id(row(item).id)).filter((value): value is number => value !== null)
    : [];
  return [...new Set([...direct, ...joins, ...groups])].sort((left, right) => left - right);
}

function accountIds(rows: Row[]): number[] {
  return rows.map((item) => id(item.id)).filter((value): value is number => value !== null);
}

function readyRecord(record: ProbeKeyRecord | undefined): boolean {
  return Boolean(record && record.ready === true && record.policyVersion === POLICY_VERSION && record.email === MONITOR_EMAIL);
}

export interface ProbeIsolationBinding {
  accountId: number;
  groupId: number;
  keyCreated: boolean;
}

interface ProbeIsolationRecordResult {
  binding: ProbeIsolationBinding;
  record: ProbeKeyRecord;
}

/**
 * 为每个 API-key 上游账号创建一组独立的私有分组和专用 Key。
 * Secret 文件只存在于 owner-only 的本地状态目录，不进入 API 响应、作业日志、账本或 Git。
 */
export class ProbeIsolationService {
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly admin: Sub2ApiClient,
    private readonly runtime: Sub2ApiRuntimeService | null = null,
  ) {}

  private filePath(): string {
    return resolve(this.config.rootDirectory, this.config.sub2api.idleProbe.isolation.secretFile);
  }

  private readFile(): ProbeKeyFile {
    const path = this.filePath();
    if (!existsSync(path)) return { version: 1, records: {} };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProbeKeyFile>;
    if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object" || Array.isArray(parsed.records)) {
      throw new Error("探活隔离 Secret 文件格式无效");
    }
    return { version: 1, monitor: parsed.monitor, records: parsed.records as Record<string, ProbeKeyRecord> };
  }

  private writeFile(value: ProbeKeyFile): void {
    const path = this.filePath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  }

  private async inLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private remainingTimeout(deadline?: number): number | undefined {
    if (deadline === undefined) return undefined;
    const remaining = Math.ceil(deadline - Date.now());
    if (remaining <= 0) throw new DOMException("The operation timed out.", "TimeoutError");
    return remaining;
  }

  private stageDeadline(deadline?: number): number {
    return deadline ?? Date.now() + this.config.operations.upstreamManagement.mutationTimeoutMs;
  }

  private async findOrCreateGroup(accountId: number, deadline?: number): Promise<number> {
    const isolation = this.config.sub2api.idleProbe.isolation;
    const name = `${isolation.groupNamePrefix}${accountId}`;
    const listed = await this.admin.request<Paginated<Row>>(
      `/admin/groups?platform=openai&search=${encodeURIComponent(name)}&page=1&page_size=100`,
      {},
      true,
      this.remainingTimeout(deadline),
    );
    const existing = pageItems(listed).find((item) => String(item.name ?? "") === name);
    const existingId = id(existing?.id);
    const groupId = existingId ?? id((await this.admin.mutate<Row>("POST", "/admin/groups", {
      name,
      description: "Api2Business 上游账号探活私有分组",
      platform: "openai",
      rate_multiplier: isolation.groupRateMultiplier,
      is_exclusive: true,
      subscription_type: "standard",
      rpm_limit: 0,
    }, undefined, this.remainingTimeout(deadline))).id);
    if (groupId === null) throw new Error("创建探活私有分组后未返回稳定 ID");

    if (existingId !== null && (existing?.is_exclusive !== true || Number(existing.rate_multiplier) !== isolation.groupRateMultiplier || String(existing.status ?? "active") !== "active")) {
      await this.admin.mutate("PUT", `/admin/groups/${groupId}`, {
        is_exclusive: true,
        rate_multiplier: isolation.groupRateMultiplier,
        status: "active",
      }, undefined, this.remainingTimeout(deadline));
    }
    const verified = row(await this.admin.request<Row>(`/admin/groups/${groupId}`, {}, true, this.remainingTimeout(deadline)));
    if (String(verified.name ?? "") !== name || verified.is_exclusive !== true || String(verified.status ?? "") !== "active") {
      throw new Error(`探活分组 ${groupId} 未通过私有属性回读`);
    }
    return groupId;
  }

  private async ensureMonitorUser(file: ProbeKeyFile, groupId: number, deadline?: number): Promise<MonitorUserRecord> {
    const password = file.monitor?.password ?? generatedSecret("Api2BusinessMonitor-");
    const listed = await this.admin.request<Paginated<Row>>(`/admin/users?search=${encodeURIComponent(MONITOR_EMAIL)}&page=1&page_size=100`, {}, true, this.remainingTimeout(deadline));
    let user = pageItems(listed).find((item) => String(item.email ?? "") === MONITOR_EMAIL);
    let userId = id(user?.id);
    let funded = file.monitor?.funded === true;
    if (userId === null) {
      user = await this.admin.mutate<Row>("POST", "/admin/users", {
        email: MONITOR_EMAIL,
        password,
        username: MONITOR_USERNAME,
        notes: "Api2Business 内部探活共享主体",
        role: "user",
        balance: this.config.sub2api.idleProbe.isolation.userBalance,
        concurrency: this.config.sub2api.idleProbe.concurrency,
        rpm_limit: 0,
        allowed_groups: [groupId],
      }, undefined, this.remainingTimeout(deadline));
      userId = id(user.id);
      funded = true;
    } else {
      const allowedGroups = [...new Set([...ids(user?.allowed_groups), groupId])];
      await this.admin.mutate("PUT", `/admin/users/${userId}`, {
        password,
        allowed_groups: allowedGroups,
        concurrency: this.config.sub2api.idleProbe.concurrency,
        rpm_limit: 0,
        ...(!funded ? { balance: this.config.sub2api.idleProbe.isolation.userBalance } : {}),
      }, undefined, this.remainingTimeout(deadline));
      funded = true;
    }
    if (userId === null) throw new Error("创建 monitor-user 后未返回稳定 ID");
    const monitor = { userId, email: MONITOR_EMAIL, password, funded };
    file.monitor = monitor;
    this.writeFile(file);
    return monitor;
  }

  private async ensureUserAndKey(accountId: number, groupId: number, stored: ProbeKeyRecord | undefined, file: ProbeKeyFile, deadline?: number): Promise<{ record: ProbeKeyRecord; keyCreated: boolean }> {
    const { email, password, userId } = await this.ensureMonitorUser(file, groupId, deadline);
    const keyName = `api2business-probe-${accountId}`;
    const storedApiKey = stored?.policyVersion === POLICY_VERSION && stored.email === MONITOR_EMAIL
      ? stored.apiKey
      : generatedSecret("sk-api2business-probe-");
    const verifiedUser = row(await this.admin.request<Row>(`/admin/users/${userId}`, {}, true, this.remainingTimeout(deadline)));
    if (!ids(verifiedUser.allowed_groups).includes(groupId)) throw new Error(`monitor-user ${userId} 未绑定私有分组 ${groupId}`);

    const userClient = this.admin.fork({ email, password });
    const keyList = await userClient.request<Paginated<Row>>(`/keys?page=1&page_size=100&search=${encodeURIComponent(keyName)}`, {}, true, this.remainingTimeout(deadline));
    const existingKey = pageItems(keyList).find((item) => String(item.name ?? "") === keyName);
    const existingKeyId = id(existingKey?.id);
    const existingPlaintext = typeof existingKey?.key === "string" ? existingKey.key : null;
    if (existingKeyId !== null) {
      if (id(existingKey?.group_id) !== groupId) await userClient.mutate("PUT", `/keys/${existingKeyId}`, { group_id: groupId }, undefined, this.remainingTimeout(deadline));
      if (existingPlaintext || storedApiKey) return {
        record: { accountId, groupId, userId, email, password, apiKey: existingPlaintext ?? storedApiKey, ready: false, policyVersion: POLICY_VERSION },
        keyCreated: false,
      };
    }
    const apiKey = existingPlaintext ?? storedApiKey;
    const created = await userClient.mutate<Row>("POST", "/keys", {
      name: keyName,
      group_id: groupId,
      custom_key: apiKey,
    }, undefined, this.remainingTimeout(deadline));
    const returnedKey = typeof created.key === "string" ? created.key : apiKey;
    return {
      record: { accountId, groupId, userId, email, password, apiKey: returnedKey, ready: false, policyVersion: POLICY_VERSION },
      keyCreated: true,
    };
  }

  private async ensureAccountBinding(accountId: number, groupId: number, deadline?: number): Promise<void> {
    const account = row(await this.admin.getAccount(accountId, this.remainingTimeout(deadline)));
    const currentGroupIds = accountGroupIds(account);
    if (!currentGroupIds.includes(groupId)) {
      if (!this.runtime) throw new Error("探活账号绑定需要 Sub2API runtime mutation service");
      await this.runtime.configureApiKeyAccounts([accountId], {
        group_ids: [...new Set([...currentGroupIds, groupId])],
      }, this.remainingTimeout(deadline));
    }
    const verifiedAccount = row(await this.admin.getAccount(accountId, this.remainingTimeout(deadline)));
    if (!accountGroupIds(verifiedAccount).includes(groupId)) throw new Error(`账号 ${accountId} 未绑定探活私有分组 ${groupId}`);
    const members = await this.admin.listGroupAccounts(groupId, "openai", this.remainingTimeout(deadline));
    const memberIds = accountIds(members as unknown as Row[]);
    if (memberIds.some((memberId) => memberId !== accountId)) {
      throw new Error(`探活私有分组 ${groupId} 存在其他账号成员，拒绝继续使用`);
    }
  }

  private async ensureRecord(accountId: number, file: ProbeKeyFile, deadline?: number): Promise<ProbeIsolationRecordResult> {
    let existing = file.records[String(accountId)];
    let groupId: number;
    try {
      groupId = await this.findOrCreateGroup(accountId, this.stageDeadline(deadline));
    } catch (error) {
      throw new Error(`探活隔离分组阶段失败：${errorMessage(error)}`);
    }
    if (!existing) {
      existing = {
        accountId,
        groupId,
        userId: 0,
        email: `api2business-probe-${accountId}@sub2api.platform-infra.local`,
        password: generatedSecret("Api2BusinessProbe-"),
        apiKey: generatedSecret("sk-api2business-probe-"),
        ready: false,
      };
      file.records[String(accountId)] = existing;
      try {
        this.writeFile(file);
      } catch (error) {
        throw new Error(`探活隔离 Secret 持久化阶段失败：${errorMessage(error)}`);
      }
    }
    let key: { record: ProbeKeyRecord; keyCreated: boolean };
    try {
      key = await this.ensureUserAndKey(accountId, groupId, existing, file, this.stageDeadline(deadline));
    } catch (error) {
      throw new Error(`探活隔离专用凭据阶段失败：${errorMessage(error)}`);
    }
    file.records[String(accountId)] = key.record;
    try {
      this.writeFile(file);
    } catch (error) {
      throw new Error(`探活隔离 Secret 持久化阶段失败：${errorMessage(error)}`);
    }
    try {
      await this.ensureAccountBinding(accountId, groupId, this.stageDeadline(deadline));
    } catch (error) {
      throw new Error(`探活隔离账号绑定阶段失败：${errorMessage(error)}`);
    }
    const completed = { ...key.record, ready: true, policyVersion: POLICY_VERSION };
    file.records[String(accountId)] = completed;
    try {
      this.writeFile(file);
    } catch (error) {
      throw new Error(`探活隔离 Secret 持久化阶段失败：${errorMessage(error)}`);
    }
    return { binding: { accountId, groupId, keyCreated: key.keyCreated }, record: completed };
  }

  async ensure(accountId: number): Promise<ProbeIsolationBinding> {
    if (!this.config.sub2api.idleProbe.isolation.enabled) throw new Error("探活隔离策略未启用");
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error("探活账号 ID 无效");
    return await this.inLock(async () => (await this.ensureRecord(accountId, this.readFile())).binding);
  }

  get(accountId: number): ProbeIsolationBinding | null {
    const record = this.readFile().records[String(accountId)];
    if (!record || !readyRecord(record)) return null;
    return { accountId, groupId: record.groupId, keyCreated: false };
  }

  async request(accountId: number, input: string, model: string, maxOutputTokens: number, timeoutMs: number): Promise<Record<string, unknown>> {
    const stored = this.readFile().records[String(accountId)];
    if (!stored || !readyRecord(stored)) throw new Error(`账号 ${accountId} 的探活隔离凭据尚未就绪`);
    const response = await fetch(`${this.config.sub2api.idleProbe.isolation.gatewayBaseUrl}/responses`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${stored.apiKey}`,
      },
      body: JSON.stringify({ model, input, max_output_tokens: maxOutputTokens, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`评测请求失败：HTTP ${response.status}`);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(text) as Record<string, unknown>; }
    catch { throw new Error("评测响应不是有效 JSON"); }
    return payload;
  }

  async probe(
    accountId: number,
    model: string,
    timeoutMs: number,
    reasoningEffort: "low" | "medium" | "high" = "low",
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const roundBudgetMs = Math.max(1_000, this.config.sub2api.idleProbe.roundTimeoutSeconds * 1_000 - 1_000);
    const deadline = startedAt + roundBudgetMs;
    const stored = this.readFile().records[String(accountId)];
    if (!stored || !readyRecord(stored)) {
      return {
        accountId,
        classification: "skipped",
        httpStatus: null,
        durationMs: Date.now() - startedAt,
        ordinaryLogRecorded: false,
        responseBytes: 0,
        errorMarker: "isolation-not-ready",
      };
    }
    const ensured = {
      binding: { accountId, groupId: stored.groupId, keyCreated: false },
      record: stored,
    };
    let response: Response;
    try {
      response = await fetch(`${this.config.sub2api.idleProbe.isolation.gatewayBaseUrl}/responses`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${ensured.record.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: "health probe",
          reasoning: { effort: reasoningEffort },
          max_output_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(Math.min(timeoutMs, this.remainingTimeout(deadline) ?? timeoutMs)),
      });
    } catch (error) {
      return {
        accountId,
        groupId: ensured.binding.groupId,
        classification: "error",
        httpStatus: null,
        durationMs: Date.now() - startedAt,
        ordinaryLogRecorded: false,
        responseBytes: 0,
        errorMarker: timeoutError(error) ? "request-timeout" : "transport-error",
        error: errorMessage(error),
      };
    }
    const body = await response.text();
    const success = response.status >= 200 && response.status < 300;
    const lowered = body.toLowerCase();
    const accountRoutingFailed = !success && [
      "no available accounts",
      "no available account",
      "no available channel",
      "not supported by any configured account",
    ].some((marker) => lowered.includes(marker));
    const classification = success ? "alive"
      : response.status === 401 || response.status === 403 ? "dead"
        : response.status === 429 ? "rate-limited" : "error";
    return {
      accountId,
      groupId: ensured.binding.groupId,
      classification,
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      ordinaryLogRecorded: !accountRoutingFailed,
      responseBytes: body.length,
      errorMarker: success ? null : accountRoutingFailed ? "no-available-account" : ["invalid_api_key", "insufficient", "rate_limit", "temporarily", "overloaded", "model_not_found"]
        .find((marker) => lowered.includes(marker)) ?? "upstream-error",
    };
  }
}
