export interface UpstreamUsageTarget {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  status: string;
  schedulable: boolean;
  apiAmountUsdTotal?: number;
}

export interface UpstreamUsageResult {
  accountId: number;
  accountName: string;
  baseUrl: string;
  status: string;
  schedulable: boolean;
  apiAmountUsdTotal: number;
  ok: boolean;
  provider: "sub2api" | "new-api" | "unknown";
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
  durationMs: number;
  warning: string | null;
  error: string | null;
}

type Row = Record<string, unknown>;

function row(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function finite(value: unknown): number | null {
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

function safeError(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/sk-[A-Za-z0-9_=+/.-]+/gu, "[REDACTED]")
    .slice(0, 240);
}

async function requestJson(target: UpstreamUsageTarget, path: string, timeoutMs: number): Promise<{
  status: number;
  payload: unknown;
}> {
  const controlBaseUrl = target.baseUrl.replace(/\/$/u, "").replace(/\/v1$/u, "");
  const response = await fetch(`${controlBaseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${target.apiKey}`,
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

function emptyResult(target: UpstreamUsageTarget, startedAt: number, days: number): UpstreamUsageResult {
  return {
    accountId: target.id,
    accountName: target.name,
    baseUrl: target.baseUrl,
    status: target.status,
    schedulable: target.schedulable,
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
  const usage = row(usageRoot?.total) ?? usageRoot ?? root;
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
  const values = Array.isArray(data) ? data : Array.isArray(dataRow?.items) ? dataRow.items : [];
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
      const other = row(item.other) ?? (() => {
        if (typeof item.other !== "string") return null;
        try { return row(JSON.parse(item.other)); } catch { return null; }
      })();
      const rawUserRatio = firstNumber(other, ["user_group_ratio"]);
      const rawGroupRatio = firstNumber(other, ["group_ratio"]);
      const userRatio = rawUserRatio !== null && rawUserRatio > 0 ? rawUserRatio : null;
      const groupRatio = rawGroupRatio !== null && rawGroupRatio > 0 ? rawGroupRatio : null;
      const ratio = userRatio ?? groupRatio;
      if (ratio !== null) {
        const createdAt = firstNumber(item, ["created_at"]);
        billingMultiplier = {
          value: ratio,
          source: "new-api-log",
          scope: userRatio !== null ? "user-group" : "group",
          observedAt: createdAt === null ? null : new Date(createdAt * 1000).toISOString(),
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
  options: { timeoutMs: number; days: number },
): Promise<UpstreamUsageResult> {
  const startedAt = Date.now();
  const failures: string[] = [];
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
    }
    failures.push(`Sub2API /v1/usage HTTP ${response.status}`);
  } catch (error) {
    failures.push(`Sub2API /v1/usage ${safeError(error)}`);
  }

  try {
    const quotaResponse = await requestJson(target, "/api/usage/token/", options.timeoutMs);
    const quota = newApiData(quotaResponse.payload);
    if (quotaResponse.status >= 200 && quotaResponse.status < 300 && quota
      && (quota.total_available !== undefined || quota.unlimited_quota !== undefined)) {
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
      const unlimited = typeof quota.unlimited_quota === "boolean" ? quota.unlimited_quota : null;
      const rawLimit = firstNumber(quota, ["total_granted"]);
      const tokenLimitUsd = quotaPerUnit !== null && quotaPerUnit > 0 && rawLimit !== null
        ? rawLimit / quotaPerUnit : null;
      result.quota = {
        limit: null,
        used: null,
        remaining: null,
        unlimited,
        unit: null,
      };
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
            remaining: Math.max(0, limitUsd - usedUsd),
            unlimited,
            unit: "USD",
          };
          result.warning = "New API 余额取自经账号级证据确认的 billing 接口";
        } else {
          result.warning = "New API 只返回 API Key 配额；缺少可证明账号钱包余额的 Dashboard/PAT 凭据";
        }
      } catch (error) {
        result.warning = `New API 账号级 billing 查询失败：${safeError(error)}`;
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

export async function queryUpstreamUsageConcurrently(
  targets: UpstreamUsageTarget[],
  options: { timeoutMs: number; days: number; concurrency: number },
): Promise<UpstreamUsageResult[]> {
  const results = new Array<UpstreamUsageResult>(targets.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(options.concurrency, targets.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= targets.length) return;
      results[index] = await queryUpstreamUsage(targets[index]!, options);
    }
  });
  await Promise.all(workers);
  return results;
}
