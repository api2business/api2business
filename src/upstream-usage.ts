import { normalizeUpstreamWallet } from "./upstream-valuation";

export interface UpstreamUsageTarget {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  walletKey?: string;
  status?: string;
  schedulable?: boolean;
  apiAmountUsdTotal?: number;
}

export interface UpstreamUsageResult {
  accountId: number;
  accountName: string;
  baseUrl: string;
  walletKey: string;
  status: string;
  schedulable: boolean;
  apiAmountUsdTotal: number;
  ok: boolean;
  provider: "sub2api" | "new-api" | "opencode-go" | "command-code" | "unknown";
  quota: {
    limit: number | null;
    used: number | null;
    remaining: number | null;
    unlimited: boolean | null;
    unit: string | null;
  };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    costUsd: number | null;
    actualCostUsd: number | null;
    requestCount: number | null;
  };
  quotaWindows: QuotaWindowObservation[];
  lowQuotaWarnings: LowQuotaWarning[];
  billingMultiplier: {
    value: number | null;
    source: "sub2api-live" | "new-api-log" | null;
    scope: "effective" | "group" | "user-group" | null;
    observedAt: string | null;
    group: number | null;
    user: number | null;
    peak: number | null;
    syncStatus?: "synchronized" | "already-synchronized" | "retained-manual" | "failed";
    synchronizedRateCnyPerApiUsd?: number | null;
    previousManualRateCnyPerApiUsd?: number | null;
    syncMessage?: string | null;
  };
  window: { days: number | null; records: number | null; complete: boolean };
  queriedAt: string;
  walletBalance?: { observedAt: string; sourceAccountId: number };
  durationMs: number;
  warning: string | null;
  error: string | null;
}

export type QuotaWindowName = "five_hour" | "weekly" | "monthly";

export interface QuotaWindowObservation {
  window: QuotaWindowName;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  unit: string | null;
  resetAt: string | null;
  observedAt: string | null;
  source: string;
  status: string | null;
  complete: boolean;
  missingReason: string | null;
}

export interface LowQuotaWarning {
  window: QuotaWindowName;
  remainingPercent: number;
  resetAt: string | null;
  thresholdPercent: number;
}

export interface QuotaProviderCoverage {
  provider: "opencode-go" | "command-code";
  accountCount: number;
  succeeded: number;
  failed: number;
  windows: Array<{
    window: QuotaWindowName;
    observed: number;
    unknown: number;
    lowQuotaWarnings: number;
  }>;
}

type Row = Record<string, unknown>;
type NewApiAccountQuota = { limit: number | null; used: number | null; remaining: number | null };

function row(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" && value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(source: Row | null, keys: string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    const value = finite(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function sumDailyUsage(root: Row | null): Row | null {
  const daily = row(root?.daily_usage);
  const items = Array.isArray(daily?.items) ? daily.items.map((item) => row(item)).filter((item): item is Row => item !== null) : [];
  if (items.length === 0) return null;
  const sum = (keys: string[]) => items.reduce((total, item) => total + (firstNumber(item, keys) ?? 0), 0);
  return {
    input_tokens: sum(["input_tokens", "inputTokens"]), output_tokens: sum(["output_tokens", "outputTokens"]),
    total_tokens: sum(["total_tokens", "totalTokens"]), cost: sum(["cost"]),
    actual_cost: sum(["actual_cost", "actualCost"]), request_count: sum(["requests", "request_count", "total_requests"]),
  };
}

function safeError(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/sk-[A-Za-z0-9_=+/.-]+/gu, "[REDACTED]")
    .slice(0, 240);
}

function responseShape(payload: unknown): string {
  const fields: string[] = [];
  const walk = (value: unknown, prefix: string, depth: number): void => {
    if (fields.length >= 40 || depth > 4) return;
    if (Array.isArray(value)) {
      fields.push(`${prefix}[]`);
      const first = value.find((item) => item !== null && item !== undefined);
      if (first !== undefined) walk(first, `${prefix}[]`, depth + 1);
      return;
    }
    const object = row(value);
    if (!object) return;
    for (const [key, child] of Object.entries(object)) {
      if (fields.length >= 40) return;
      const path = prefix ? `${prefix}.${key}` : key;
      fields.push(path);
      if (child && typeof child === "object") walk(child, path, depth + 1);
    }
  };
  walk(payload, "", 0);
  return fields.join(", ");
}

async function requestJson(target: UpstreamUsageTarget, path: string, timeoutMs: number): Promise<{
  status: number;
  payload: unknown;
}> {
  const controlBaseUrl = target.baseUrl.replace(/\/$/u, "").replace(/\/v1$/u, "");
  return await requestJsonUrl(`${controlBaseUrl}${path}`, target.apiKey, timeoutMs);
}

async function requestOriginJson(target: UpstreamUsageTarget, path: string, timeoutMs: number): Promise<{
  status: number;
  payload: unknown;
}> {
  return await requestJsonUrl(new URL(path, new URL(target.baseUrl).origin).toString(), target.apiKey, timeoutMs);
}

async function requestJsonUrl(url: string, apiKey: string, timeoutMs: number): Promise<{
  status: number;
  payload: unknown;
}> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      "user-agent": "Api2Business-Upstream-Usage/1.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text.trim()) {
    try { payload = JSON.parse(text) as unknown; }
    catch { payload = { error: `上游返回非 JSON 响应（HTTP ${response.status}）` }; }
  }
  return { status: response.status, payload };
}

function rawNewApiQuotaToUsd(value: number | null, status: Row | null): number | null {
  if (value === null) return null;
  const quotaPerUnit = firstNumber(status, ["quota_per_unit"]);
  if (quotaPerUnit === null || quotaPerUnit <= 0) return null;
  const displayType = String(status?.quota_display_type ?? "USD").toUpperCase();
  if (displayType === "TOKENS") return null;
  const usd = value / quotaPerUnit;
  if (displayType === "CNY") {
    const exchangeRate = firstNumber(status, ["usd_exchange_rate"]);
    return exchangeRate !== null && exchangeRate > 0 ? usd * exchangeRate : null;
  }
  return usd;
}

function parseNewApiTokenUserQuota(payload: unknown, status: Row | null): {
  limit: number | null;
  used: number | null;
  remaining: number | null;
} | null {
  const data = newApiData(payload);
  const userQuota = row(data?.user_quota);
  if (!userQuota) return null;
  const remaining = rawNewApiQuotaToUsd(
    firstNumber(userQuota, ["total_available", "remaining", "quota"]),
    status,
  );
  const used = rawNewApiQuotaToUsd(
    firstNumber(userQuota, ["total_used", "used_quota", "used"]),
    status,
  );
  if (remaining === null && used === null) return null;
  return { limit: remaining !== null && used !== null ? remaining + used : null, used, remaining };
}

function emptyResult(target: UpstreamUsageTarget, startedAt: number, days: number): UpstreamUsageResult {
  return {
    accountId: target.id,
    accountName: target.name,
    baseUrl: target.baseUrl,
    walletKey: target.walletKey ?? normalizeUpstreamWallet(target.baseUrl),
    status: target.status ?? "unknown",
    schedulable: target.schedulable ?? false,
    apiAmountUsdTotal: finite(target.apiAmountUsdTotal) ?? 0,
    ok: false,
    provider: "unknown",
    quota: { limit: null, used: null, remaining: null, unlimited: null, unit: null },
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      actualCostUsd: null,
      requestCount: null,
    },
    quotaWindows: [],
    lowQuotaWarnings: [],
    billingMultiplier: {
      value: null, source: null, scope: null, observedAt: null,
      group: null, user: null, peak: null,
    },
    window: { days, records: null, complete: false },
    queriedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    warning: null,
    error: null,
  };
}

function parseSub2ApiBilling(payload: unknown): UpstreamUsageResult["billingMultiplier"] | null {
  const root = row(payload);
  if (!root || root.object !== "sub2api.key_billing" || Number(root.schema_version) !== 1) return null;
  const effective = firstNumber(root, ["effective_rate_multiplier"]);
  if (effective === null || effective <= 0) return null;
  return {
    value: effective,
    source: "sub2api-live",
    scope: "effective",
    observedAt: typeof root.observed_at === "string" ? root.observed_at : null,
    group: firstNumber(root, ["group_rate_multiplier"]),
    user: firstNumber(root, ["user_rate_multiplier"]),
    peak: firstNumber(root, ["applied_peak_multiplier"]),
  };
}

function parseSub2Api(target: UpstreamUsageTarget, payload: unknown, startedAt: number, days: number): UpstreamUsageResult | null {
  const root = row(payload);
  if (!root || (!row(root.usage) && !row(root.quota) && typeof root.mode !== "string")) return null;
  const quota = row(root.quota);
  const usageRoot = row(root.usage);
  // 额度监控请求 1 天窗口时必须读取供应商返回的 today 汇总；total 是账号累计值，
  // 不能把累计实际扣除冒充 24 小时成本。较旧上游没有 today 时保持空值，交由上层显示无数据。
  const usage = (days <= 1 ? row(usageRoot?.today) : null) ?? (days > 1 ? sumDailyUsage(root) : null)
    ?? (days <= 1 ? null : row(usageRoot?.total)) ?? usageRoot ?? root;
  const subscription = row(root.subscription);
  const inputTokens = firstNumber(usage, ["input_tokens", "inputTokens"]);
  const outputTokens = firstNumber(usage, ["output_tokens", "outputTokens"]);
  const explicitTotal = firstNumber(usage, ["total_tokens", "totalTokens"]);
  const quotaLimit = firstNumber(quota, ["limit"])
    ?? firstNumber(subscription, ["monthly_limit_usd", "weekly_limit_usd", "daily_limit_usd"]);
  const quotaUsed = firstNumber(quota, ["used"])
    ?? firstNumber(subscription, ["monthly_usage_usd", "weekly_usage_usd", "daily_usage_usd"]);
  const quotaRemaining = firstNumber(quota, ["remaining"])
    ?? firstNumber(root, ["remaining", "balance"]);
  const costUsd = firstNumber(usage, ["cost", "cost_usd", "costUsd"]);
  const actualCostUsd = firstNumber(usage, ["actual_cost", "actual_cost_usd", "actualCostUsd"]);
  const requestCount = firstNumber(usage, ["request_count", "requests", "total_requests"]);
  const hasQuotaData = quotaLimit !== null || quotaUsed !== null || quotaRemaining !== null;
  const hasUsageData = inputTokens !== null || outputTokens !== null || explicitTotal !== null
    || costUsd !== null || actualCostUsd !== null || requestCount !== null;
  if (!hasQuotaData && !hasUsageData) return null;
  const result = emptyResult(target, startedAt, days);
  result.ok = true;
  result.provider = "sub2api";
  result.quota = {
    limit: quotaLimit,
    used: quotaUsed,
    remaining: quotaRemaining,
    unlimited: root.mode === "unrestricted" && quotaRemaining === null ? null : false,
    unit: typeof quota?.unit === "string" ? quota.unit : typeof root.unit === "string" ? root.unit : "USD",
  };
  if (root.mode === "quota_limited") {
    result.quota = { limit: null, used: null, remaining: null, unlimited: null, unit: null };
    result.warning = "Sub2API 只返回 API Key 配额，不能证明账号钱包余额";
  }
  result.usage = {
    inputTokens,
    outputTokens,
    totalTokens: explicitTotal ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    costUsd,
    actualCostUsd,
    requestCount,
  };
  result.window.complete = true;
  return result;
}

const QUOTA_WINDOW_ALIASES: Record<QuotaWindowName, string[]> = {
  five_hour: ["rolling", "five_hour", "fivehour", "5h", "5_hour", "five_hour_limit"],
  weekly: ["weekly", "week", "7d", "seven_day", "seven_day_limit", "weekly_limit"],
  monthly: ["monthly", "month", "30d", "thirty_day", "monthly_limit"],
};

function canonicalKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function firstString(source: Row | null, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function timestampIso(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  const numeric = finite(value);
  if (numeric === null || numeric <= 0) return null;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function observationRows(payload: unknown): Row[] {
  const root = row(payload);
  if (!root) return [];
  const data = row(root.data);
  const candidates: Array<Row | null> = [
    root,
    data,
    row(root.usage),
    row(root.summary),
    row(root.limits),
    row(root.usage_limits),
    row(root.quota),
    row(root.windowLimits),
    row(root.credits),
    row(data?.summary),
    row(data?.usage),
    row(data?.limits),
    row(data?.usage_limits),
    row(data?.quota),
    row(data?.windowLimits),
    row(data?.credits),
  ];
  return candidates.filter((candidate, index): candidate is Row =>
    candidate !== null && candidates.findIndex((item) => item === candidate) === index);
}

function findWindowCandidate(payload: unknown, aliases: string[]): { value: Row; container: Row } | null {
  const aliasSet = new Set(aliases.map(canonicalKey));
  const rows = observationRows(payload);
  for (const container of rows) {
    for (const [key, value] of Object.entries(container)) {
      const candidate = row(value);
      if (candidate && aliasSet.has(canonicalKey(key))) return { value: candidate, container };
    }
    for (const key of ["windows", "rate_limits", "usage_windows", "usage_limits", "limits"]) {
      const entries = Array.isArray(container[key]) ? container[key] : [];
      for (const entry of entries) {
        const candidate = row(entry);
        const name = firstString(candidate, ["window", "name", "period", "key"]);
        if (candidate && name && aliasSet.has(canonicalKey(name))) return { value: candidate, container };
      }
    }
  }
  return null;
}

function normalizedPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

function parseQuotaWindow(
  payload: unknown,
  window: QuotaWindowName,
  source: string,
  observedAt: string,
): QuotaWindowObservation {
  const found = findWindowCandidate(payload, QUOTA_WINDOW_ALIASES[window]);
  if (!found) {
    return {
      window,
      limit: null,
      used: null,
      remaining: null,
      usedPercent: null,
      remainingPercent: null,
      unit: null,
      resetAt: null,
      observedAt: null,
      source,
      status: null,
      complete: false,
      missingReason: "upstream-response-missing-window",
    };
  }
  const value = found.value;
  const limit = firstNumber(value, ["limit", "total", "quota", "allowance", "cap"]);
  const used = firstNumber(value, ["used", "consumed", "usage"]);
  const explicitRemaining = firstNumber(value, ["remaining", "available", "left", "balance"]);
  const remaining = explicitRemaining ?? (limit !== null && used !== null ? limit - used : null);
  const explicitUsedPercent = normalizedPercent(firstNumber(value, [
    "percent", "used_percent", "usedPercent", "usage_percent", "usagePercent", "utilization", "utilization_percent",
  ]));
  const explicitRemainingPercent = normalizedPercent(firstNumber(value, [
    "remaining_percent", "remainingPercent", "available_percent", "availablePercent",
  ]));
  const usedPercent = explicitUsedPercent
    ?? (explicitRemainingPercent !== null ? 100 - explicitRemainingPercent : null)
    ?? (limit !== null && limit > 0 && used !== null ? normalizedPercent((used / limit) * 100) : null);
  const remainingPercent = explicitRemainingPercent
    ?? (usedPercent !== null ? normalizedPercent(100 - usedPercent) : null)
    ?? (limit !== null && limit > 0 && remaining !== null ? normalizedPercent((remaining / limit) * 100) : null);
  const resetAt = timestampIso(value.reset_at ?? value.resets_at ?? value.resetAt ?? value.resetsAt);
  const exceeded = value.exceeded;
  const status = firstString(value, ["status", "state"])
    ?? (typeof exceeded === "boolean" ? (exceeded ? "rate-limited" : "ok") : null);
  const unit = firstString(value, ["unit", "currency"]) ?? firstString(found.container, ["unit", "currency"]);
  const complete = limit !== null || used !== null || remaining !== null || usedPercent !== null
    || remainingPercent !== null || resetAt !== null || status !== null;
  return {
    window,
    limit,
    used,
    remaining,
    usedPercent,
    remainingPercent,
    unit,
    resetAt,
    observedAt: complete ? observedAt : null,
    source,
    status,
    complete,
    missingReason: complete ? null : "upstream-window-has-no-observable-fields",
  };
}

function payloadObservedAt(payload: unknown, fallback: string): string {
  const root = row(payload);
  return timestampIso(root?.observed_at ?? root?.fetched_at ?? row(root?.data)?.observed_at ?? row(root?.data)?.fetched_at)
    ?? fallback;
}

function lowQuotaWarnings(windows: QuotaWindowObservation[], thresholdPercent: number): LowQuotaWarning[] {
  return windows.flatMap((window) => window.remainingPercent !== null && window.remainingPercent <= thresholdPercent
    ? [{ window: window.window, remainingPercent: window.remainingPercent, resetAt: window.resetAt, thresholdPercent }]
    : []);
}

function parseProviderQuotaWindows(
  target: UpstreamUsageTarget,
  payload: unknown,
  startedAt: number,
  days: number,
  provider: "opencode-go" | "command-code",
  source: string,
  thresholdPercent: number,
): UpstreamUsageResult | null {
  const queriedAt = new Date().toISOString();
  const observedAt = payloadObservedAt(payload, queriedAt);
  const windows = (["five_hour", "weekly", "monthly"] as const)
    .map((window) => parseQuotaWindow(payload, window, source, observedAt));
  if (provider === "command-code") {
    const root = row(payload);
    const data = row(root?.data);
    const credits = row(root?.credits) ?? row(data?.credits);
    const monthlyIndex = windows.findIndex((window) => window.window === "monthly");
    const monthlyCredits = firstNumber(credits, ["monthlyCredits", "monthly_credits"]);
    if (!windows[monthlyIndex]?.complete && monthlyCredits !== null) {
      const belowThreshold = credits?.belowThreshold;
      windows[monthlyIndex] = {
        window: "monthly",
        limit: null,
        used: null,
        remaining: monthlyCredits,
        usedPercent: null,
        remainingPercent: null,
        unit: "credits",
        resetAt: timestampIso(data?.currentPeriodEnd ?? root?.currentPeriodEnd),
        observedAt,
        source,
        status: typeof belowThreshold === "boolean" ? (belowThreshold ? "low" : "ok") : null,
        complete: false,
        missingReason: "upstream-monthly-limit-or-percent-missing",
      };
    }
    for (const item of windows) {
      if (item.complete && item.unit === null && item.window !== "monthly") item.unit = "USD";
    }
  }
  if (!windows.some((window) => window.complete)) return null;
  const result = emptyResult(target, startedAt, days);
  result.ok = true;
  result.provider = provider;
  result.quotaWindows = windows;
  result.lowQuotaWarnings = lowQuotaWarnings(windows, thresholdPercent);
  const missing = windows.filter((window) => !window.complete).map((window) => window.window);
  result.window.complete = missing.length === 0;
  result.warning = missing.length === 0 ? null : `上游未返回 ${missing.join(", ")} 窗口，缺失值保持未知`;
  result.queriedAt = queriedAt;
  return result;
}

function newApiData(payload: unknown): Row | null {
  const root = row(payload);
  return row(root?.data) ?? root;
}

function displayedQuotaToUsd(value: number | null, status: Row | null): number | null {
  if (value === null) return null;
  const displayType = String(status?.quota_display_type ?? "USD").toUpperCase();
  if (displayType === "TOKENS") return null;
  if (displayType === "CNY") {
    const exchangeRate = firstNumber(status, ["usd_exchange_rate"]);
    return exchangeRate !== null && exchangeRate > 0 ? value / exchangeRate : null;
  }
  return value;
}

function parseNewApiLogs(payload: unknown): {
  input: number;
  output: number;
  records: number;
  billingMultiplier: UpstreamUsageResult["billingMultiplier"] | null;
} {
  const root = row(payload);
  const data = root?.data;
  const dataRow = row(data);
  const values = Array.isArray(data)
    ? data
    : [dataRow, root]
      .flatMap((candidate) => {
        if (!candidate) return [];
        for (const key of ["items", "logs", "rows", "records", "list"]) {
          if (Array.isArray(candidate[key])) return candidate[key];
        }
        return [];
      });
  let input = 0;
  let output = 0;
  let records = 0;
  let billingMultiplier: UpstreamUsageResult["billingMultiplier"] | null = null;
  for (const value of values) {
    const item = row(value);
    if (!item) continue;
    input += firstNumber(item, ["prompt_tokens", "input_tokens"]) ?? 0;
    output += firstNumber(item, ["completion_tokens", "output_tokens"]) ?? 0;
    records += 1;
    if (billingMultiplier === null) {
      const parseOther = (value: unknown): Row | null => {
        if (row(value)) return row(value);
        if (typeof value !== "string") return null;
        let parsed: unknown = value;
        for (let attempt = 0; attempt < 2 && typeof parsed === "string"; attempt += 1) {
          try { parsed = JSON.parse(parsed) as unknown; } catch { return null; }
        }
        return row(parsed);
      };
      const other = parseOther(item.other);
      const billing = row(other?.billing) ?? row(other?.pricing) ?? row(other?.rate) ?? null;
      const ratioSource = [other, billing, item].find((candidate) => candidate !== null
        && (firstNumber(candidate, ["user_group_ratio", "userGroupRatio", "group_special_ratio"]) !== null
          || firstNumber(candidate, ["group_ratio", "groupRatio", "effective_group_ratio"]) !== null)) ?? null;
      const rawUserRatio = firstNumber(ratioSource, ["user_group_ratio", "userGroupRatio", "group_special_ratio"]);
      const rawGroupRatio = firstNumber(ratioSource, ["group_ratio", "groupRatio", "effective_group_ratio"]);
      const userRatio = rawUserRatio !== null && rawUserRatio > 0 ? rawUserRatio : null;
      const groupRatio = rawGroupRatio !== null && rawGroupRatio > 0 ? rawGroupRatio : null;
      const ratio = userRatio ?? groupRatio;
      if (ratio !== null) {
        const createdAt = firstNumber(item, ["created_at", "createdAt", "timestamp"]);
        const observedAt = createdAt === null ? null
          : new Date(createdAt < 10_000_000_000 ? createdAt * 1000 : createdAt).toISOString();
        billingMultiplier = {
          value: ratio,
          source: "new-api-log",
          scope: userRatio !== null ? "user-group" : "group",
          observedAt,
          group: groupRatio,
          user: userRatio,
          peak: null,
        };
      }
    }
  }
  return { input, output, records, billingMultiplier };
}

export async function queryUpstreamUsage(
  target: UpstreamUsageTarget,
  options: { timeoutMs: number; days: number; lowQuotaRemainingPercent?: number },
): Promise<UpstreamUsageResult> {
  const startedAt = Date.now();
  const failures: string[] = [];
  const thresholdPercent = normalizedPercent(options.lowQuotaRemainingPercent ?? 20) ?? 20;
  const targetHost = new URL(target.baseUrl).hostname.toLowerCase();
  try {
    const response = await requestJson(target, `/v1/usage?days=${options.days}`, options.timeoutMs);
    if (response.status >= 200 && response.status < 300) {
      const parsed = parseSub2Api(target, response.payload, startedAt, options.days);
      if (parsed) {
        try {
          const billingResponse = await requestJson(target, "/v1/sub2api/billing", options.timeoutMs);
          if (billingResponse.status >= 200 && billingResponse.status < 300) {
            parsed.billingMultiplier = parseSub2ApiBilling(billingResponse.payload) ?? parsed.billingMultiplier;
          } else if (billingResponse.status !== 404 && billingResponse.status !== 405) {
            parsed.warning = `Sub2API 额度查询成功，但倍率探测返回 HTTP ${billingResponse.status}`;
          }
        } catch (error) {
          parsed.warning = `Sub2API 额度查询成功，但倍率探测失败：${safeError(error)}`;
        }
        parsed.durationMs = Date.now() - startedAt;
        return parsed;
      }
      if (targetHost === "opencode.ai" || targetHost.endsWith(".opencode.ai")) {
        const windows = parseProviderQuotaWindows(
          target,
          response.payload,
          startedAt,
          options.days,
          "opencode-go",
          "opencode:/v1/usage",
          thresholdPercent,
        );
        if (windows) {
          windows.durationMs = Date.now() - startedAt;
          return windows;
        }
        failures.push(`OpenCode /v1/usage HTTP 200 但响应没有可识别的 5 小时/周/月窗口；字段：${responseShape(response.payload)}`);
        return emptyResultWithFailures(target, startedAt, options.days, failures);
      }
    }
    failures.push(`Sub2API /v1/usage HTTP ${response.status}`);
  } catch (error) {
    failures.push(`Sub2API /v1/usage ${safeError(error)}`);
  }

  if (targetHost === "commandcode.ai" || targetHost.endsWith(".commandcode.ai")) {
    try {
      const summaryResponse = await requestOriginJson(target, "/alpha/usage/summary", options.timeoutMs);
      if (summaryResponse.status >= 200 && summaryResponse.status < 300) {
        const windows = parseProviderQuotaWindows(
          target,
          summaryResponse.payload,
          startedAt,
          options.days,
          "command-code",
          "command-code:/alpha/usage/summary",
          thresholdPercent,
        );
        if (windows) {
          windows.durationMs = Date.now() - startedAt;
          return windows;
        }
        failures.push(`CommandCode /alpha/usage/summary HTTP 200 但响应没有可识别的 5 小时/周/月窗口；字段：${responseShape(summaryResponse.payload)}`);
        for (const path of ["/alpha/billing/credits", "/alpha/billing/subscriptions"]) {
          try {
            const billingResponse = await requestOriginJson(target, path, options.timeoutMs);
            if (billingResponse.status >= 200 && billingResponse.status < 300) {
              const billingWindows = parseProviderQuotaWindows(
                target,
                billingResponse.payload,
                startedAt,
                options.days,
                "command-code",
                `command-code:${path}`,
                thresholdPercent,
              );
              if (billingWindows) {
                billingWindows.durationMs = Date.now() - startedAt;
                return billingWindows;
              }
              failures.push(`CommandCode ${path} HTTP 200 但响应没有可识别的 5 小时/周/月窗口；字段：${responseShape(billingResponse.payload)}`);
            } else {
              failures.push(`CommandCode ${path} HTTP ${billingResponse.status}`);
            }
          } catch (error) {
            failures.push(`CommandCode ${path} ${safeError(error)}`);
          }
        }
        return emptyResultWithFailures(target, startedAt, options.days, failures);
      }
      failures.push(`CommandCode /alpha/usage/summary HTTP ${summaryResponse.status}`);
    } catch (error) {
      failures.push(`CommandCode /alpha/usage/summary ${safeError(error)}`);
    }
  }

  let accountQuota: { limit: number | null; used: number | null; remaining: number | null } | null = null;
  let accountQuotaSource: "token-user-quota" | null = null;

  try {
    const quotaResponse = await requestJson(target, "/api/usage/token/", options.timeoutMs);
    const quota = newApiData(quotaResponse.payload);
    const hasUserQuota = quota !== null && row(quota.user_quota) !== null;
    if (accountQuota || (quotaResponse.status >= 200 && quotaResponse.status < 300 && quota
      && (quota.total_available !== undefined || quota.unlimited_quota !== undefined || hasUserQuota))) {
      const result = emptyResult(target, startedAt, options.days);
      result.ok = true;
      result.provider = "new-api";
      let status: Row | null = null;
      try {
        const statusResponse = await requestJson(target, "/api/status", options.timeoutMs);
        if (statusResponse.status >= 200 && statusResponse.status < 300) status = newApiData(statusResponse.payload);
      } catch {
        // The token endpoint remains useful when older New API forks do not expose status.
      }
      const quotaPerUnit = firstNumber(status, ["quota_per_unit"]);
      if (!accountQuota) {
        const tokenUserQuota = parseNewApiTokenUserQuota(quotaResponse.payload, status);
        if (tokenUserQuota) {
          accountQuota = tokenUserQuota;
          accountQuotaSource = "token-user-quota";
        }
      }
      const unlimited = typeof quota?.unlimited_quota === "boolean" ? quota.unlimited_quota : null;
      const rawLimit = firstNumber(quota, ["total_granted"]);
      const tokenLimitUsd = quotaPerUnit !== null && quotaPerUnit > 0 && rawLimit !== null
        ? rawLimit / quotaPerUnit : null;
      result.quota = accountQuota
        ? { ...accountQuota, unlimited: false, unit: "USD" }
        : { limit: null, used: null, remaining: null, unlimited, unit: null };
      if (accountQuotaSource === "token-user-quota") {
        result.warning = "New API 余额取自 API Key 授权返回的 user_quota（令牌所属用户整体额度）";
      }
      if (!accountQuota) {
        try {
          const [subscriptionResponse, billingResponse] = await Promise.all([
            requestJson(target, "/dashboard/billing/subscription", options.timeoutMs),
            requestJson(target, "/dashboard/billing/usage", options.timeoutMs),
          ]);
          const subscription = row(subscriptionResponse.payload);
          const billing = row(billingResponse.payload);
          const displayedLimit = firstNumber(subscription, ["hard_limit_usd", "system_hard_limit_usd"]);
          const displayedUsedCents = firstNumber(billing, ["total_usage"]);
          const limitUsd = displayedQuotaToUsd(displayedLimit, status);
          const usedUsd = displayedQuotaToUsd(displayedUsedCents === null ? null : displayedUsedCents / 100, status);
          const accountLevelEvidence = limitUsd !== null && limitUsd < 100_000_000
            && (unlimited === true || (tokenLimitUsd !== null && Math.abs(limitUsd - tokenLimitUsd) > 0.000001));
          if (subscriptionResponse.status >= 200 && subscriptionResponse.status < 300
            && billingResponse.status >= 200 && billingResponse.status < 300
            && accountLevelEvidence && usedUsd !== null) {
            result.quota = {
              limit: limitUsd,
              used: usedUsd,
              remaining: limitUsd - usedUsd,
              unlimited,
              unit: "USD",
            };
            result.warning = "New API 余额取自经账号级证据确认的 billing 接口";
          } else {
            result.warning = [
              "New API 只返回 API Key 配额；缺少可证明账号钱包余额的 Dashboard/PAT 凭据",
            ].join("；");
          }
        } catch (error) {
          result.warning = `New API 账号级 billing 查询失败：${safeError(error)}`;
        }
      }
      try {
        const logsResponse = await requestJson(target, "/api/log/token", options.timeoutMs);
        if (logsResponse.status >= 200 && logsResponse.status < 300) {
          const logs = parseNewApiLogs(logsResponse.payload);
          result.usage.inputTokens = logs.input;
          result.usage.outputTokens = logs.output;
          result.usage.totalTokens = logs.input + logs.output;
          result.usage.requestCount = logs.records;
          result.window.records = logs.records;
          if (logs.billingMultiplier) result.billingMultiplier = logs.billingMultiplier;
          result.warning = [result.warning, "New API token 用量仅覆盖最近日志，不代表全生命周期汇总"]
            .filter(Boolean).join("；");
          if (!logs.billingMultiplier) {
            result.warning = [result.warning, "New API 最近消费日志没有可证明的计费倍率"]
              .filter(Boolean).join("；");
          }
        } else {
          result.warning = [result.warning, `额度查询成功，但最近 token 日志查询返回 HTTP ${logsResponse.status}`]
            .filter(Boolean).join("；");
        }
      } catch (error) {
        result.warning = [result.warning, `额度查询成功，但最近 token 日志查询失败：${safeError(error)}`]
          .filter(Boolean).join("；");
      }
      result.durationMs = Date.now() - startedAt;
      return result;
    }
    failures.push(`New API /api/usage/token/ HTTP ${quotaResponse.status}`);
  } catch (error) {
    failures.push(`New API /api/usage/token/ ${safeError(error)}`);
  }

  const result = emptyResult(target, startedAt, options.days);
  result.error = failures.join("；");
  return result;
}

function emptyResultWithFailures(
  target: UpstreamUsageTarget,
  startedAt: number,
  days: number,
  failures: string[],
): UpstreamUsageResult {
  const result = emptyResult(target, startedAt, days);
  result.error = failures.join("；");
  return result;
}

export async function queryUpstreamUsageConcurrently(
  targets: UpstreamUsageTarget[],
  options: { timeoutMs: number; days: number; concurrency: number; lowQuotaRemainingPercent?: number },
): Promise<UpstreamUsageResult[]> {
  const results = new Array<UpstreamUsageResult>(targets.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(options.concurrency, targets.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= targets.length) return;
      results[index] = await queryUpstreamUsage(targets[index]!, {
        ...options,
      });
    }
  });
  await Promise.all(workers);
  // /v1/usage also carries API-key-specific token usage. Keep those account
  // reads, but consume only one wallet balance observation for the round.
  // Never copy one key's usage, billing multiplier or failure to another key.
  const balances = new Map<string, UpstreamUsageResult>();
  for (const result of results) {
    if (!result.ok || result.quota.unit !== "USD" || result.quota.remaining === null
      || !Number.isFinite(result.quota.remaining)) continue;
    const key = normalizeUpstreamWallet(result.walletKey);
    const previous = balances.get(key);
    const observedAt = result.walletBalance?.observedAt ?? result.queriedAt;
    if (!previous || observedAt < (previous.walletBalance?.observedAt ?? previous.queriedAt)) balances.set(key, result);
  }
  for (const result of results) {
    const source = balances.get(normalizeUpstreamWallet(result.walletKey));
    if (!source) continue;
    result.quota = { ...source.quota };
    result.walletBalance = { observedAt: source.walletBalance?.observedAt ?? source.queriedAt,
      sourceAccountId: source.walletBalance?.sourceAccountId ?? source.accountId };
  }
  return results;
}

function quotaCoverageProvider(result: UpstreamUsageResult): QuotaProviderCoverage["provider"] | null {
  if (result.provider === "opencode-go" || result.provider === "command-code") return result.provider;
  let url: URL;
  try {
    url = new URL(result.baseUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "opencode.ai" && url.pathname.replace(/\/$/u, "").includes("/zen/go")) return "opencode-go";
  if (host === "commandcode.ai" || host.endsWith(".commandcode.ai")) return "command-code";
  return null;
}

export function summarizeQuotaProviderCoverage(results: UpstreamUsageResult[]): QuotaProviderCoverage[] {
  return (["opencode-go", "command-code"] as const).flatMap((provider) => {
    const matches = results.filter((result) => quotaCoverageProvider(result) === provider);
    if (matches.length === 0) return [];
    return [{
      provider,
      accountCount: matches.length,
      succeeded: matches.filter((result) => result.ok).length,
      failed: matches.filter((result) => !result.ok).length,
      windows: (["five_hour", "weekly", "monthly"] as const).map((window) => ({
        window,
        observed: matches.filter((result) => result.quotaWindows.some((item) => item.window === window && item.complete)).length,
        unknown: matches.filter((result) => !result.quotaWindows.some((item) => item.window === window && item.complete)).length,
        lowQuotaWarnings: matches.filter((result) => result.lowQuotaWarnings.some((item) => item.window === window)).length,
      })),
    }];
  });
}
