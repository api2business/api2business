export interface UpstreamUsageTarget {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
}

export interface UpstreamUsageResult {
  accountId: number;
  accountName: string;
  baseUrl: string;
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
      "user-agent": "ApiState-Upstream-Usage/1.0",
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
    window: { days, records: null, complete: false },
    queriedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    warning: null,
    error: null,
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

function parseNewApiLogs(payload: unknown): { input: number; output: number; records: number } {
  const root = row(payload);
  const data = root?.data;
  const dataRow = row(data);
  const values = Array.isArray(data) ? data : Array.isArray(dataRow?.items) ? dataRow.items : [];
  let input = 0;
  let output = 0;
  let records = 0;
  for (const value of values) {
    const item = row(value);
    if (!item) continue;
    input += firstNumber(item, ["prompt_tokens", "input_tokens"]) ?? 0;
    output += firstNumber(item, ["completion_tokens", "output_tokens"]) ?? 0;
    records += 1;
  }
  return { input, output, records };
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
      if (parsed) return parsed;
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
      result.quota = {
        limit: firstNumber(quota, ["total_granted"]),
        used: firstNumber(quota, ["total_used"]),
        remaining: firstNumber(quota, ["total_available"]),
        unlimited: typeof quota.unlimited_quota === "boolean" ? quota.unlimited_quota : null,
        unit: "internal_quota",
      };
      try {
        const logsResponse = await requestJson(target, "/api/log/token", options.timeoutMs);
        if (logsResponse.status >= 200 && logsResponse.status < 300) {
          const logs = parseNewApiLogs(logsResponse.payload);
          result.usage.inputTokens = logs.input;
          result.usage.outputTokens = logs.output;
          result.usage.totalTokens = logs.input + logs.output;
          result.usage.requestCount = logs.records;
          result.window.records = logs.records;
          result.warning = "New API token 用量仅覆盖最近日志，不代表全生命周期汇总";
        } else {
          result.warning = `额度查询成功，但最近 token 日志查询返回 HTTP ${logsResponse.status}`;
        }
      } catch (error) {
        result.warning = `额度查询成功，但最近 token 日志查询失败：${safeError(error)}`;
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
