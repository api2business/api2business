import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "./config";
import {
  buildMathProbeRequestBody,
  createMathProbeQuestion,
  parseMathProbeAnswer,
  PROBE_CACHE_PREFIX_FINGERPRINT,
  type MathProbeTransport,
} from "./probe-math";
import type { Paginated, Sub2ApiClient } from "./sub2api-client";
import type { Sub2ApiRuntimeService } from "./sub2api-runtime-service";

type Row = Record<string, unknown>;

interface ProbeKeyRecord {
  accountId: number;
  groupId: number;
  platform?: string;
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

interface ProbeStreamResult {
  body: string;
  visibleText: string;
  firstVisibleAt: number | null;
  terminalReceived: boolean;
  terminalEvent: string | null;
  terminalStatus: "completed" | "incomplete" | "failed" | "cancelled" | null;
  finishReason: string | null;
  refusal: string | null;
  streamed: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheReadField: string | null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function visibleText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    const item = row(part);
    return typeof item.text === "string" ? item.text : "";
  }).join("");
}

function findRefusal(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRefusal(item);
      if (found !== null) return found;
    }
    return null;
  }
  const node = value as Row;
  if (typeof node.refusal === "string" && node.refusal.trim().length > 0) return node.refusal;
  for (const child of Object.values(node)) {
    const found = findRefusal(child);
    if (found !== null) return found;
  }
  return null;
}

function findResponseText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(findResponseText).join("");
  const node = value as Row;
  if (node.type === "output_text" && typeof node.text === "string") return node.text;
  if (node.type === "text" && typeof node.text === "string") return node.text;
  return Array.isArray(node.content) ? findResponseText(node.content) : "";
}

async function readProbeStream(response: Response, startedAt: number): Promise<ProbeStreamResult> {
  const reader = response.body?.getReader();
  if (!reader) return {
    body: "",
    visibleText: "",
    firstVisibleAt: null,
    terminalReceived: false,
    terminalEvent: null,
    terminalStatus: null,
    finishReason: null,
    refusal: null,
    streamed: false,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheReadField: null,
  };

  const decoder = new TextDecoder();
  const rawChunks: string[] = [];
  let parseBuffer = "";
  let answerText = "";
  let firstVisibleAt: number | null = null;
  let terminalReceived = false;
  let terminalEvent: string | null = null;
  let terminalStatus: ProbeStreamResult["terminalStatus"] = null;
  let finishReason: string | null = null;
  let refusal: string | null = null;
  let sawSse = false;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheReadField: string | null = null;

  const consumeUsage = (value: unknown): void => {
    const usage = row(value);
    if (Object.keys(usage).length === 0) return;
    inputTokens ??= nonNegativeNumber(usage.input_tokens) ?? nonNegativeNumber(usage.prompt_tokens);
    outputTokens ??= nonNegativeNumber(usage.output_tokens) ?? nonNegativeNumber(usage.completion_tokens);
    if (cacheReadTokens !== null) return;
    const inputDetails = row(usage.input_tokens_details);
    const promptDetails = row(usage.prompt_tokens_details);
    const candidates: Array<[string, unknown]> = [
      ["input_tokens_details.cached_tokens", inputDetails.cached_tokens],
      ["prompt_tokens_details.cached_tokens", promptDetails.cached_tokens],
      ["cache_read_input_tokens", usage.cache_read_input_tokens],
      ["cache_read_tokens", usage.cache_read_tokens],
      ["cached_tokens", usage.cached_tokens],
    ];
    for (const [field, candidate] of candidates) {
      const parsed = nonNegativeNumber(candidate);
      if (parsed !== null) {
        cacheReadTokens = parsed;
        cacheReadField = field;
        return;
      }
    }
  };

  const appendVisible = (text: string): void => {
    if (text.length === 0) return;
    answerText += text;
    if (firstVisibleAt === null && text.trim().length > 0) firstVisibleAt = Date.now();
  };
  const consumePayload = (payload: Row, eventName: string | null): void => {
    const type = typeof payload.type === "string" ? payload.type : eventName;
    const choices = Array.isArray(payload.choices) ? payload.choices.map(row) : [];
    const choice = choices[0] ?? {};
    const delta = row(choice.delta);
    const message = row(choice.message);
    if (typeof delta.content === "string" || Array.isArray(delta.content)) appendVisible(visibleText(delta.content));
    if (typeof message.content === "string" || Array.isArray(message.content)) appendVisible(visibleText(message.content));
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    refusal ??= findRefusal(payload);
    consumeUsage(payload.usage);

    if (type === "response.output_text.delta" && typeof payload.delta === "string") appendVisible(payload.delta);
    if (type === "response.output_text.done" && answerText.length === 0 && typeof payload.text === "string") appendVisible(payload.text);
    if (type === "response.refusal.done" && typeof payload.refusal === "string") refusal ??= payload.refusal;

    const nestedResponse = row(payload.response);
    const responseNode = Object.keys(nestedResponse).length > 0
      ? nestedResponse
      : payload.object === "response"
        ? payload
        : {};
    consumeUsage(responseNode.usage);
    if (answerText.length === 0 && Array.isArray(responseNode.output)) appendVisible(findResponseText(responseNode.output));
    if (typeof responseNode.status === "string" && ["completed", "incomplete", "failed", "cancelled"].includes(responseNode.status)) {
      terminalReceived = true;
      terminalEvent = type ?? `response.${responseNode.status}`;
      terminalStatus = responseNode.status as ProbeStreamResult["terminalStatus"];
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed" || type === "response.cancelled") {
      terminalReceived = true;
      terminalEvent = type;
      terminalStatus = type.slice("response.".length) as ProbeStreamResult["terminalStatus"];
    }
    if (type === "error") {
      terminalReceived = true;
      terminalEvent = type;
      terminalStatus = "failed";
    }
  };
  const consumeEventBlock = (block: string): void => {
    sawSse = true;
    let eventName: string | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice("event:".length).trim() || null;
      if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
    }
    const joined = data.join("\n").trim();
    if (joined === "[DONE]") {
      terminalReceived = true;
      terminalEvent = "chat.completions.done";
      terminalStatus = "completed";
      return;
    }
    if (!joined || joined === "[DONE]") return;
    try {
      const payload = JSON.parse(joined) as Row;
      consumePayload(payload, eventName);
    } catch {
      // Non-JSON SSE events cannot contribute a verifiable model answer.
    }
  };
  const drainEvents = (final: boolean): void => {
    parseBuffer = parseBuffer.replace(/\r\n/gu, "\n");
    for (;;) {
      const boundary = parseBuffer.indexOf("\n\n");
      if (boundary < 0) break;
      const block = parseBuffer.slice(0, boundary);
      parseBuffer = parseBuffer.slice(boundary + 2);
      if (block.trim()) consumeEventBlock(block);
    }
    if (final && parseBuffer.trim()) {
      consumeEventBlock(parseBuffer);
      parseBuffer = "";
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawChunks.push(chunk);
    parseBuffer += chunk;
    drainEvents(false);
  }
  const tail = decoder.decode();
  if (tail) {
    rawChunks.push(tail);
    parseBuffer += tail;
  }
  drainEvents(true);
  const body = rawChunks.join("");
  if (!sawSse && body.trim()) {
    try {
      const payload = JSON.parse(body) as Row;
      consumePayload(payload, null);
      if (finishReason !== null && !terminalReceived) {
        terminalReceived = true;
        terminalEvent = "chat.completions.non_stream_complete";
        terminalStatus = "completed";
      }
    } catch {
      // The caller records the HTTP response as protocol-invalid.
    }
  }
  return {
    body,
    visibleText: answerText,
    firstVisibleAt,
    terminalReceived,
    terminalEvent,
    terminalStatus,
    finishReason,
    refusal,
    streamed: sawSse,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheReadField,
  };
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

export interface ProbeIsolationScope {
  platform: "openai" | "anthropic" | "grok" | "deepseek" | "opencode_go";
  eligibleGroupIds: number[];
  /**
   * 账号已经拥有的业务分组之外，需要补绑的分组。
   * V2 作用域只用于筛选账号，不能把整个作用域白名单写回每个账号。
   */
  bindingGroupIds?: number[];
}

export interface ProbeMonitorBalance {
  userId: number;
  balanceUsd: number;
  targetBalanceUsd: number;
  replenished: boolean;
  observedAt: string;
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

  private async findOrCreateGroup(accountId: number, scope: ProbeIsolationScope, deadline?: number): Promise<number> {
    const isolation = this.config.sub2api.idleProbe.isolation;
    const baseName = `${isolation.groupNamePrefix}${accountId}`;
    const listed = await this.admin.request<Paginated<Row>>(
      `/admin/groups?platform=${encodeURIComponent(scope.platform)}&search=${encodeURIComponent(baseName)}&page=1&page_size=100`,
      {},
      true,
      this.remainingTimeout(deadline),
    );
    const existing = pageItems(listed).find((item) => String(item.name ?? "") === baseName
      && String(item.platform ?? "") === scope.platform);
    let name = baseName;
    if (!existing) {
      const allPlatforms = await this.admin.request<Paginated<Row>>(
        `/admin/groups?search=${encodeURIComponent(baseName)}&page=1&page_size=100`,
        {},
        true,
        this.remainingTimeout(deadline),
      );
      const conflicting = pageItems(allPlatforms).some((item) => String(item.name ?? "") === baseName
        && String(item.platform ?? "") !== scope.platform);
      if (conflicting) name = `${isolation.groupNamePrefix}${scope.platform}-${accountId}`;
    }
    const existingId = id(existing?.id);
    const groupId = existingId ?? id((await this.admin.mutate<Row>("POST", "/admin/groups", {
      name,
      description: "Api2Business 上游账号探活私有分组",
      platform: scope.platform,
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
    let funded = false;
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
      const observedBalance = Number(user?.balance);
      funded = Number.isFinite(observedBalance) && observedBalance > 0;
      const allowedGroups = [...new Set([...ids(user?.allowed_groups), groupId])];
      const needsUpdate = !ids(user?.allowed_groups).includes(groupId)
        || Number(user?.concurrency) !== this.config.sub2api.idleProbe.concurrency
        || Number(user?.rpm_limit ?? 0) !== 0
        || !funded;
      if (needsUpdate) {
        await this.admin.mutate("PUT", `/admin/users/${userId}`, {
          password,
          allowed_groups: allowedGroups,
          concurrency: this.config.sub2api.idleProbe.concurrency,
          rpm_limit: 0,
          ...(!funded ? { balance: this.config.sub2api.idleProbe.isolation.userBalance } : {}),
        }, undefined, this.remainingTimeout(deadline));
      }
      funded = true;
    }
    if (userId === null) throw new Error("创建 monitor-user 后未返回稳定 ID");
    const monitor = { userId, email: MONITOR_EMAIL, password, funded };
    file.monitor = monitor;
    this.writeFile(file);
    return monitor;
  }

  /**
   * Reconcile the shared monitor wallet before a probe round. The persisted
   * `funded` flag is evidence from an earlier write, not current authority:
   * probe traffic continuously consumes this wallet, so a ready account record
   * must not suppress a live balance check.
   */
  async ensureMonitorBalance(deadline?: number): Promise<ProbeMonitorBalance | null> {
    if (!this.config.sub2api.idleProbe.isolation.enabled) return null;
    return await this.inLock(async () => {
      const file = this.readFile();
      const monitor = file.monitor;
      if (!monitor || !Number.isSafeInteger(monitor.userId) || monitor.userId <= 0) return null;
      const targetBalanceUsd = this.config.sub2api.idleProbe.isolation.userBalance;
      const observed = row(await this.admin.request<Row>(`/admin/users/${monitor.userId}`, {}, true, this.remainingTimeout(deadline)));
      const before = Number(observed.balance);
      if (!Number.isFinite(before)) throw new Error(`monitor-user ${monitor.userId} 余额回读无效`);
      let balanceUsd = before;
      let replenished = false;
      if (before <= 0) {
        const updated = row(await this.admin.mutate<Row>("PUT", `/admin/users/${monitor.userId}`, {
          balance: targetBalanceUsd,
        }, undefined, this.remainingTimeout(deadline)));
        balanceUsd = Number(updated.balance);
        if (!Number.isFinite(balanceUsd) || balanceUsd <= 0) {
          throw new Error(`monitor-user ${monitor.userId} 余额补充后未恢复为正数`);
        }
        replenished = true;
      }
      if (file.monitor?.funded !== true) {
        file.monitor = { ...monitor, funded: true };
        this.writeFile(file);
      }
      return {
        userId: monitor.userId,
        balanceUsd,
        targetBalanceUsd,
        replenished,
        observedAt: new Date().toISOString(),
      };
    });
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
    const created = await userClient.mutate<Row>("POST", "/keys", {
      name: keyName,
      group_id: groupId,
    }, undefined, this.remainingTimeout(deadline));
    if (typeof created.key !== "string" || created.key.length === 0) {
      throw new Error("Sub2API 原生生成探活 Key 后未返回凭据");
    }
    return {
      record: { accountId, groupId, userId, email, password, apiKey: created.key, ready: false, policyVersion: POLICY_VERSION },
      keyCreated: true,
    };
  }

  private async ensureAccountBinding(accountId: number, groupId: number, scope: ProbeIsolationScope, deadline?: number): Promise<void> {
    const account = row(await this.admin.getAccount(accountId, this.remainingTimeout(deadline)));
    const currentGroupIds = accountGroupIds(account);
    const desiredGroupIds = [...new Set([
      ...currentGroupIds,
      ...(scope.bindingGroupIds ?? scope.eligibleGroupIds),
      groupId,
    ])].sort((left, right) => left - right);
    if (desiredGroupIds.some((desiredGroupId) => !currentGroupIds.includes(desiredGroupId))) {
      if (!this.runtime) throw new Error("探活账号绑定需要 Sub2API runtime mutation service");
      await this.runtime.configureApiKeyAccounts([accountId], {
        group_ids: desiredGroupIds,
      }, this.remainingTimeout(deadline), scope.platform);
    }
    const verifiedAccount = row(await this.admin.getAccount(accountId, this.remainingTimeout(deadline)));
    const verifiedGroupIds = accountGroupIds(verifiedAccount);
    const missingGroupIds = desiredGroupIds.filter((desiredGroupId) => !verifiedGroupIds.includes(desiredGroupId));
    if (missingGroupIds.length > 0) throw new Error(`账号 ${accountId} 未绑定目标分组 ${missingGroupIds.join(",")}`);
    const members = await this.admin.listGroupAccounts(groupId, scope.platform, this.remainingTimeout(deadline));
    const memberIds = accountIds(members as unknown as Row[]);
    if (memberIds.some((memberId) => memberId !== accountId)) {
      throw new Error(`探活私有分组 ${groupId} 存在其他账号成员，拒绝继续使用`);
    }
  }

  private async ensureRecord(accountId: number, scope: ProbeIsolationScope, file: ProbeKeyFile, deadline?: number): Promise<ProbeIsolationRecordResult> {
    let existing = file.records[String(accountId)];
    if (existing?.platform && existing.platform !== scope.platform) {
      const account = row(await this.admin.getAccount(accountId, this.remainingTimeout(this.stageDeadline(deadline))));
      if (String(account.platform ?? "") !== scope.platform) {
        throw new Error(`账号 ${accountId} 的实际平台不匹配 ${scope.platform}，不能迁移探活隔离凭据`);
      }
      // 修复旧入口错误标记的平台；重新查找实际平台的私有组并迁移专用 Key。
      existing.platform = scope.platform;
    }
    if (existing && !existing.platform && scope.platform !== "openai") {
      // 早期 Grok 记录可能在凭据已就绪后遗漏平台字段。先以 Sub2API
      // 原生账号平台回读确认，再补写字段；平台不匹配时仍拒绝复用。
      const account = row(await this.admin.getAccount(accountId, this.stageDeadline(deadline)));
      if (String(account.platform ?? "") !== scope.platform) {
        throw new Error(`账号 ${accountId} 的旧探活隔离凭据未记录平台，不能直接复用到 ${scope.platform}`);
      }
      existing.platform = scope.platform;
      this.writeFile(file);
    }
    let groupId: number;
    try {
      groupId = await this.findOrCreateGroup(accountId, scope, this.stageDeadline(deadline));
    } catch (error) {
      throw new Error(`探活隔离分组阶段失败：${errorMessage(error)}`);
    }
    if (!existing) {
      existing = {
        accountId,
        groupId,
        platform: scope.platform,
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
    existing.platform = scope.platform;
    let key: { record: ProbeKeyRecord; keyCreated: boolean };
    try {
      key = await this.ensureUserAndKey(accountId, groupId, existing, file, this.stageDeadline(deadline));
    } catch (error) {
      throw new Error(`探活隔离专用凭据阶段失败：${errorMessage(error)}`);
    }
    file.records[String(accountId)] = { ...key.record, platform: scope.platform };
    try {
      this.writeFile(file);
    } catch (error) {
      throw new Error(`探活隔离 Secret 持久化阶段失败：${errorMessage(error)}`);
    }
    try {
      await this.ensureAccountBinding(accountId, groupId, scope, this.stageDeadline(deadline));
    } catch (error) {
      throw new Error(`探活隔离账号绑定阶段失败：${errorMessage(error)}`);
    }
    const completed = { ...key.record, platform: scope.platform, ready: true, policyVersion: POLICY_VERSION };
    file.records[String(accountId)] = completed;
    try {
      this.writeFile(file);
    } catch (error) {
      throw new Error(`探活隔离 Secret 持久化阶段失败：${errorMessage(error)}`);
    }
    return { binding: { accountId, groupId, keyCreated: key.keyCreated }, record: completed };
  }

  async ensure(accountId: number, scope?: ProbeIsolationScope): Promise<ProbeIsolationBinding> {
    if (!this.config.sub2api.idleProbe.isolation.enabled) throw new Error("探活隔离策略未启用");
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error("探活账号 ID 无效");
    return await this.inLock(async () => {
      let account: Row;
      try {
        account = row(await this.admin.getAccount(accountId, this.config.operations.upstreamManagement.mutationTimeoutMs));
      } catch (error) {
        throw new Error(`探活账号平台识别阶段失败：${errorMessage(error)}`);
      }
      const platform = String(account.platform ?? "").toLowerCase();
      if (platform !== "openai" && platform !== "anthropic" && platform !== "grok" && platform !== "deepseek") {
        throw new Error(`账号 ${accountId} 缺少受支持的平台，不能创建探活隔离`);
      }
      if (scope && scope.platform !== platform) throw new Error(`账号 ${accountId} 的实际平台与探活作用域不一致`);
      const actualScope = scope ?? (platform === "openai"
        ? {
            platform,
            eligibleGroupIds: this.config.operations.upstreamManagement.groupIds,
            bindingGroupIds: this.config.operations.upstreamManagement.groupIds,
          }
        : { platform, eligibleGroupIds: accountGroupIds(account), bindingGroupIds: [] });
      return (await this.ensureRecord(accountId, actualScope, this.readFile())).binding;
    });
  }

  get(accountId: number, scope?: ProbeIsolationScope): ProbeIsolationBinding | null {
    const record = this.readFile().records[String(accountId)];
    if (!record || !readyRecord(record)) return null;
    if (scope && ((record.platform && record.platform !== scope.platform)
      || (!record.platform && scope.platform !== "openai"))) return null;
    return { accountId, groupId: record.groupId, keyCreated: false };
  }

  async request(accountId: number, input: string, model: string, maxOutputTokens: number, timeoutMs: number): Promise<Record<string, unknown>> {
    const stored = this.readFile().records[String(accountId)];
    if (!stored || !readyRecord(stored)) throw new Error(`账号 ${accountId} 的探活隔离凭据尚未就绪`);
    const chatCompletions = stored.platform === "deepseek";
    const response = await fetch(`${this.config.sub2api.idleProbe.isolation.gatewayBaseUrl}${chatCompletions ? "/chat/completions" : "/responses"}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${stored.apiKey}`,
      },
      body: JSON.stringify(chatCompletions
        ? { model, messages: [{ role: "user", content: input }], max_tokens: maxOutputTokens, stream: false }
        : { model, input, max_output_tokens: maxOutputTokens, stream: false }),
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
    const question = createMathProbeQuestion();
    const roundBudgetMs = Math.max(1_000, this.config.sub2api.idleProbe.roundTimeoutSeconds * 1_000 - 1_000);
    const deadline = startedAt + roundBudgetMs;
    const stored = this.readFile().records[String(accountId)];
    if (!stored || !readyRecord(stored)) {
      return {
        accountId,
        classification: "skipped",
        answerClassification: "not_assessed",
        qualityOk: false,
        questionId: question.questionId,
        questionPrompt: question.prompt,
        expectedAnswer: question.expectedAnswer,
        answerRaw: "",
        parsedAnswer: null,
        trimmedNumeric: false,
        ttftMs: null,
        postTtftMs: null,
        endToEndMs: Date.now() - startedAt,
        httpStatus: null,
        durationMs: Date.now() - startedAt,
        ordinaryLogRecorded: false,
        responseBytes: 0,
        errorMarker: "isolation-not-ready",
        requestKind: "probe",
        cachePrefixFingerprint: PROBE_CACHE_PREFIX_FINGERPRINT,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheReadField: null,
        cacheHit: null,
      };
    }
    const ensured = {
      binding: { accountId, groupId: stored.groupId, keyCreated: false },
      record: stored,
    };
    const requestId = crypto.randomUUID();
    const transport: MathProbeTransport = ensured.record.platform === "deepseek" ? "chat_completions" : "responses";
    const probeRequest = buildMathProbeRequestBody({
      model,
      question: question.prompt,
      transport,
      reasoningEffort,
      maxOutputTokens: 256,
    });
    const requestEvidence = { accountId, groupId: ensured.binding.groupId, model,
      startedAt: new Date(startedAt).toISOString(), requestId,
      questionId: question.questionId, questionPrompt: question.prompt, expectedAnswer: question.expectedAnswer,
      requestKind: "probe", transport,
      cachePrefixFingerprint: probeRequest.cachePrefixFingerprint };
    let response: Response;
    let stream: ProbeStreamResult;
    try {
      const chatCompletions = transport === "chat_completions";
      response = await fetch(`${this.config.sub2api.idleProbe.isolation.gatewayBaseUrl}${chatCompletions ? "/chat/completions" : "/responses"}`, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          "x-request-id": requestId,
          authorization: `Bearer ${ensured.record.apiKey}`,
        },
        // TTFT is emitted by Sub2API only for streaming responses. Keep the
        // probe body streaming so every successful probe contributes a
        // first-token sample to every platform scope.
        body: JSON.stringify(probeRequest.body),
        signal: AbortSignal.timeout(Math.min(timeoutMs, this.remainingTimeout(deadline) ?? timeoutMs)),
      });
      stream = await readProbeStream(response, startedAt);
    } catch (error) {
      const completedAt = Date.now();
      return {
        ...requestEvidence,
        completedAt: new Date(completedAt).toISOString(),
        classification: "error",
        answerClassification: "not_assessed",
        qualityOk: false,
        answerRaw: "",
        parsedAnswer: null,
        trimmedNumeric: false,
        ttftMs: null,
        postTtftMs: null,
        endToEndMs: completedAt - startedAt,
        terminalReceived: false,
        terminalEvent: null,
        terminalStatus: null,
        finishReason: null,
        refusal: null,
        httpStatus: null,
        durationMs: completedAt - startedAt,
        ordinaryLogRecorded: false,
        responseBytes: 0,
        errorMarker: timeoutError(error) ? "request-timeout" : "transport-error",
        error: errorMessage(error),
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheReadField: null,
        cacheHit: null,
      };
    }
    const completedAt = Date.now();
    const mathAnswer = parseMathProbeAnswer(stream.visibleText, question.expectedAnswer);
    const answerClassification = stream.refusal !== null ? "refused"
      : stream.finishReason === "length" ? "truncated"
        : stream.terminalStatus === "failed" ? "failed"
          : stream.terminalStatus === "incomplete" || !stream.terminalReceived ? "incomplete"
            : mathAnswer.classification;
    const success = response.status >= 200 && response.status < 300;
    const lowered = stream.body.toLowerCase();
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
      ...requestEvidence,
      completedAt: new Date(completedAt).toISOString(),
      // This is returned by the native gateway, not a caller-selected marker.
      clientRequestId: response.headers.get("x-client-request-id")?.trim() || null,
      classification,
      answerClassification: success ? answerClassification : "not_assessed",
      qualityOk: success && answerClassification === "correct",
      answerRaw: stream.visibleText,
      parsedAnswer: mathAnswer.parsedAnswer,
      trimmedNumeric: mathAnswer.trimmedNumeric,
      ttftMs: stream.firstVisibleAt === null ? null : stream.firstVisibleAt - startedAt,
      postTtftMs: stream.firstVisibleAt === null ? null : completedAt - stream.firstVisibleAt,
      endToEndMs: completedAt - startedAt,
      terminalReceived: stream.terminalReceived,
      terminalEvent: stream.terminalEvent,
      terminalStatus: stream.terminalStatus,
      finishReason: stream.finishReason,
      refusal: stream.refusal,
      httpStatus: response.status,
      durationMs: completedAt - startedAt,
      ordinaryLogRecorded: !accountRoutingFailed,
      responseBytes: stream.body.length,
      inputTokens: stream.inputTokens,
      outputTokens: stream.outputTokens,
      cacheReadTokens: stream.cacheReadTokens,
      cacheReadField: stream.cacheReadField,
      cacheHit: stream.cacheReadTokens === null ? null : stream.cacheReadTokens > 0,
      errorMarker: success ? null : accountRoutingFailed ? "no-available-account" : ["invalid_api_key", "insufficient", "rate_limit", "temporarily", "overloaded", "model_not_found"]
        .find((marker) => lowered.includes(marker)) ?? "upstream-error",
    };
  }
}
