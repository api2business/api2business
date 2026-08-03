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
}

interface ProbeKeyFile {
  version: 1;
  records: Record<string, ProbeKeyRecord>;
}

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
    return { version: 1, records: parsed.records as Record<string, ProbeKeyRecord> };
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

  private async findOrCreateGroup(accountId: number): Promise<number> {
    const isolation = this.config.sub2api.idleProbe.isolation;
    const name = `${isolation.groupNamePrefix}${accountId}`;
    const listed = await this.admin.request<Paginated<Row>>(
      `/admin/groups?platform=openai&search=${encodeURIComponent(name)}&page=1&page_size=100`,
    );
    const existing = pageItems(listed).find((item) => String(item.name ?? "") === name);
    const existingId = id(existing?.id);
    const groupId = existingId ?? id((await this.admin.mutate<Row>("POST", "/admin/groups", {
      name,
      description: "ApiState 上游账号探活私有分组",
      platform: "openai",
      rate_multiplier: isolation.groupRateMultiplier,
      is_exclusive: true,
      subscription_type: "standard",
      rpm_limit: 0,
    })).id);
    if (groupId === null) throw new Error("创建探活私有分组后未返回稳定 ID");

    if (existingId !== null && (existing?.is_exclusive !== true || Number(existing.rate_multiplier) !== isolation.groupRateMultiplier || String(existing.status ?? "active") !== "active")) {
      await this.admin.mutate("PUT", `/admin/groups/${groupId}`, {
        is_exclusive: true,
        rate_multiplier: isolation.groupRateMultiplier,
        status: "active",
      });
    }
    const verified = row(await this.admin.request<Row>(`/admin/groups/${groupId}`));
    if (String(verified.name ?? "") !== name || verified.is_exclusive !== true || String(verified.status ?? "") !== "active") {
      throw new Error(`探活分组 ${groupId} 未通过私有属性回读`);
    }
    return groupId;
  }

  private async ensureUserAndKey(accountId: number, groupId: number, stored: ProbeKeyRecord | undefined): Promise<{ record: ProbeKeyRecord; keyCreated: boolean }> {
    const email = stored?.email ?? `apistate-probe-${accountId}@sub2api.platform-infra.local`;
    const password = stored?.password ?? generatedSecret("ApistateProbe-");
    const storedApiKey = stored?.apiKey ?? generatedSecret("sk-apistate-probe-");
    const listed = await this.admin.request<Paginated<Row>>(`/admin/users?search=${encodeURIComponent(email)}&page=1&page_size=100`);
    let user = pageItems(listed).find((item) => String(item.email ?? "") === email);
    let userId = id(user?.id);
    if (userId === null) {
      user = await this.admin.mutate<Row>("POST", "/admin/users", {
        email,
        password,
        username: `apistate-probe-${accountId}`,
        notes: "ApiState 内部探活主体",
        role: "user",
        balance: this.config.sub2api.idleProbe.isolation.userBalance,
        concurrency: 1,
        rpm_limit: 0,
        allowed_groups: [groupId],
      });
      userId = id(user.id);
    } else {
      const allowedGroups = [...new Set([...ids(user?.allowed_groups), groupId])];
      const balance = Number(user?.balance);
      await this.admin.mutate("PUT", `/admin/users/${userId}`, {
        password,
        allowed_groups: allowedGroups,
        concurrency: 1,
        rpm_limit: 0,
        ...(Number.isFinite(balance) && balance > 0 ? {} : { balance: this.config.sub2api.idleProbe.isolation.userBalance }),
      });
    }
    if (userId === null) throw new Error("创建探活专用用户后未返回稳定 ID");
    const verifiedUser = row(await this.admin.request<Row>(`/admin/users/${userId}`));
    if (!ids(verifiedUser.allowed_groups).includes(groupId)) throw new Error(`探活专用用户 ${userId} 未绑定私有分组 ${groupId}`);

    const userClient = this.admin.fork({ email, password });
    const keyList = await userClient.request<Paginated<Row>>("/keys?page=1&page_size=100&search=apistate-probe");
    const existingKey = pageItems(keyList).find((item) => String(item.name ?? "") === "apistate-probe");
    const existingKeyId = id(existingKey?.id);
    const existingPlaintext = typeof existingKey?.key === "string" ? existingKey.key : null;
    if (existingKeyId !== null) {
      if (id(existingKey?.group_id) !== groupId) await userClient.mutate("PUT", `/keys/${existingKeyId}`, { group_id: groupId });
      if (existingPlaintext || stored?.apiKey) return {
        record: { accountId, groupId, userId, email, password, apiKey: existingPlaintext ?? storedApiKey },
        keyCreated: false,
      };
    }
    const apiKey = existingPlaintext ?? storedApiKey;
    const created = await userClient.mutate<Row>("POST", "/keys", {
      name: "apistate-probe",
      group_id: groupId,
      custom_key: apiKey,
    });
    const returnedKey = typeof created.key === "string" ? created.key : apiKey;
    return {
      record: { accountId, groupId, userId, email, password, apiKey: returnedKey },
      keyCreated: true,
    };
  }

  private async ensureAccountBinding(accountId: number, groupId: number): Promise<void> {
    const account = row(await this.admin.getAccount(accountId));
    const currentGroupIds = accountGroupIds(account);
    if (!currentGroupIds.includes(groupId)) {
      if (!this.runtime) throw new Error("探活账号绑定需要 Sub2API runtime mutation service");
      await this.runtime.updateAccount(accountId, {
        group_ids: [...new Set([...currentGroupIds, groupId])],
        confirm_mixed_channel_risk: true,
      });
    }
    const verifiedAccount = row(await this.admin.getAccount(accountId));
    if (!accountGroupIds(verifiedAccount).includes(groupId)) throw new Error(`账号 ${accountId} 未绑定探活私有分组 ${groupId}`);
    const members = await this.admin.listGroupAccounts(groupId, "openai");
    const memberIds = accountIds(members as unknown as Row[]);
    if (memberIds.some((memberId) => memberId !== accountId)) {
      throw new Error(`探活私有分组 ${groupId} 存在其他账号成员，拒绝继续使用`);
    }
  }

  private async ensureRecord(accountId: number, file: ProbeKeyFile): Promise<ProbeIsolationRecordResult> {
    let existing = file.records[String(accountId)];
    let groupId: number;
    try {
      groupId = await this.findOrCreateGroup(accountId);
    } catch (error) {
      throw new Error(`探活隔离分组阶段失败：${errorMessage(error)}`);
    }
    if (!existing) {
      existing = {
        accountId,
        groupId,
        userId: 0,
        email: `apistate-probe-${accountId}@sub2api.platform-infra.local`,
        password: generatedSecret("ApistateProbe-"),
        apiKey: generatedSecret("sk-apistate-probe-"),
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
      key = await this.ensureUserAndKey(accountId, groupId, existing);
    } catch (error) {
      throw new Error(`探活隔离专用凭据阶段失败：${errorMessage(error)}`);
    }
    try {
      await this.ensureAccountBinding(accountId, groupId);
    } catch (error) {
      throw new Error(`探活隔离账号绑定阶段失败：${errorMessage(error)}`);
    }
    file.records[String(accountId)] = key.record;
    try {
      this.writeFile(file);
    } catch (error) {
      throw new Error(`探活隔离 Secret 持久化阶段失败：${errorMessage(error)}`);
    }
    return { binding: { accountId, groupId, keyCreated: key.keyCreated }, record: key.record };
  }

  async ensure(accountId: number): Promise<ProbeIsolationBinding> {
    if (!this.config.sub2api.idleProbe.isolation.enabled) throw new Error("探活隔离策略未启用");
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error("探活账号 ID 无效");
    return await this.inLock(async () => (await this.ensureRecord(accountId, this.readFile())).binding);
  }

  get(accountId: number): ProbeIsolationBinding | null {
    const record = this.readFile().records[String(accountId)];
    return record && id(record.userId) !== null
      ? { accountId, groupId: record.groupId, keyCreated: false }
      : null;
  }

  async probe(accountId: number, model: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const ensured = await this.inLock(async () => await this.ensureRecord(accountId, this.readFile()));
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.config.sub2api.idleProbe.isolation.gatewayBaseUrl}/responses`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${ensured.record.apiKey}`,
        },
        body: JSON.stringify({ model, input: "health probe", max_output_tokens: 1, stream: false }),
        signal: AbortSignal.timeout(timeoutMs),
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
    const classification = success ? "alive"
      : response.status === 401 || response.status === 403 ? "dead"
        : response.status === 429 ? "rate-limited" : "error";
    return {
      accountId,
      groupId: ensured.binding.groupId,
      classification,
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      ordinaryLogRecorded: true,
      responseBytes: body.length,
      errorMarker: success ? null : ["invalid_api_key", "insufficient", "rate_limit", "temporarily", "overloaded", "model_not_found"]
        .find((marker) => lowered.includes(marker)) ?? "upstream-error",
    };
  }
}
