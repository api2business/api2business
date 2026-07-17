import type {
  Sub2ApiAccount,
  Sub2ApiGroup,
  Sub2ApiRequestError,
  Sub2ApiSystemLog,
  Sub2ApiUsageRow,
} from "./sub2api-client";
import { Sub2ApiClient } from "./sub2api-client";
import type { RuntimePolicyEventSource } from "./runtime-policy-events";

type Row = Record<string, unknown>;

export interface NativeGroupScoreInput {
  group: Sub2ApiGroup;
  accounts: Sub2ApiAccount[];
  usage: Sub2ApiUsageRow[];
  requestErrors: Sub2ApiRequestError[];
  systemLogs: Sub2ApiSystemLog[];
  overview: Record<string, unknown>;
  availability: NativeOpsResult;
  concurrency: NativeOpsResult;
}

interface NativeOpsResult {
  status: "available" | "unavailable";
  data: Row;
  reason: string | null;
}

const policyMarkers = {
  temp: "account_temp_unschedulable",
  failover: "openai.upstream_failover_switching",
  forward: "openai.forward_failed",
  retryOpenAI: "openai.pool_mode_same_account_retry",
  retryGateway: "gateway.failover_same_account_retry",
  completed: "http request completed",
} as const;

export const nativeScoreSystemLogMarkers = Object.values(policyMarkers);

function windowStart(window: string, now: Date): Date {
  const match = window.match(/^([1-9][0-9]*)(m|h|d)$/u);
  if (!match) throw new Error(`unsupported score window: ${window}`);
  const amount = Number(match[1]);
  const unitMs = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(now.getTime() - amount * unitMs);
}

export async function collectNativeScores(client: Sub2ApiClient, eventSource: RuntimePolicyEventSource, window: string, now = new Date()): Promise<{ groups: Row[]; accounts: Row[]; collection: Row }> {
  const start = windowStart(window, now);
  const groups = await client.listGroups();
  const policyEvents = await eventSource.collect(window);
  const groupRows: Row[] = [];
  const accountRows: Row[] = [];
  const collectionRows: Row[] = [];
  for (const group of groups) {
    // Keep database-heavy reads sequential on the two-core Sub2API host.
    const accounts = await client.listGroupAccounts(group.id, group.platform);
    const overview = await client.getOpsOverview(group.id, group.platform, start);
    const availability = await optionalOps(() => client.getOpsAccountAvailability(group.id, group.platform));
    const concurrency = await optionalOps(() => client.getOpsConcurrency(group.id, group.platform));
    const usage = await client.listGroupUsage(group.id, start, now);
    const requestErrors = await client.listRequestErrors(group.id, group.platform, start);
    const result = aggregateNativeGroupScore({ group, accounts, usage, requestErrors, systemLogs: policyEvents.events, overview, availability, concurrency });
    groupRows.push(result.group);
    accountRows.push(...result.accounts.map((account) => ({ groupId: group.id, groupName: group.name, platform: group.platform, ...account })));
    collectionRows.push({ groupId: group.id, groupName: group.name, ...result.collection });
  }
  return {
    groups: groupRows,
    accounts: accountRows,
    collection: {
      mode: "nc01-native-api-local-aggregation",
      window,
      startAt: start.toISOString(),
      endAt: now.toISOString(),
      groupCount: groups.length,
      groups: collectionRows,
      policyEvents: policyEvents.evidence,
    },
  };
}

async function optionalOps(operation: () => Promise<Row>): Promise<NativeOpsResult> {
  try {
    return { status: "available", data: await operation(), reason: null };
  } catch (error) {
    return { status: "unavailable", data: {}, reason: error instanceof Error ? error.message : String(error) };
  }
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isFinite(parsed) ? parsed : null;
}

function record(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, ordered.length - 1);
  return Math.round(ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (position - lower));
}

function costRate(name: string): number | null {
  const match = name.match(/(\d+(?:\.\d+)?)$/u);
  return match ? Number(match[1]) : null;
}

function extra(log: Sub2ApiSystemLog): Row {
  return log.extra && typeof log.extra === "object" ? log.extra : {};
}

function accountId(log: Sub2ApiSystemLog): number | null {
  return numeric(log.account_id) ?? numeric(extra(log).account_id);
}

function requestId(log: Sub2ApiSystemLog): string | null {
  const value = log.request_id ?? extra(log).request_id;
  return typeof value === "string" && value ? value : null;
}

function groupMatches(log: Sub2ApiSystemLog, groupId: number): boolean {
  const value = numeric(extra(log).group_id);
  return value === null || value === groupId;
}

function customerErrorAttribution(row: Sub2ApiRequestError): { scoreable: boolean; reason: string } {
  const message = String(row.message ?? row.error_message ?? "").toLowerCase();
  if (message.includes("context window") || message.includes("context_length_exceeded")) return { scoreable: false, reason: "context-window" };
  if (message.includes("input must be a list")) return { scoreable: false, reason: "invalid-client-input" };
  if (message.includes("not supported by any configured account") || message.includes("no available channel for model")) return { scoreable: false, reason: "model-route" };
  const phase = String(row.phase ?? "").toLowerCase();
  if (["internal", "client", "business"].includes(phase)) return { scoreable: false, reason: "non-upstream-phase" };
  if (row.account_id === null || row.account_id === undefined) return { scoreable: false, reason: "no-account-attribution" };
  const category = String(row.type ?? "").toLowerCase();
  if (phase === "upstream" || category.includes("upstream")) return { scoreable: true, reason: "explicit-upstream" };
  const stable = ["upstream service temporarily unavailable", "upstream request failed", "bad gateway", "gateway timeout", "error code: 502", "error code: 503", "error code: 504", "error code: 524"];
  return stable.some((marker) => message.includes(marker))
    ? { scoreable: true, reason: "stable-upstream-message" }
    : { scoreable: false, reason: "unattributed-customer-error" };
}

function grade(score: number | null, comparable: boolean, attempts: number): string {
  if (score === null || (!comparable && !(score < 60 && attempts >= 10))) return "insufficient";
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "E";
}

export function aggregateNativeGroupScore(input: NativeGroupScoreInput): { group: Row; accounts: Row[]; collection: Row } {
  const usageByAccount = new Map<number, Sub2ApiUsageRow[]>();
  for (const row of input.usage) {
    if (row.account_id === null) continue;
    usageByAccount.set(row.account_id, [...(usageByAccount.get(row.account_id) ?? []), row]);
  }

  const scoreableByAccount = new Map<number, Set<string>>();
  const excludedByAccount = new Map<number, Map<string, number>>();
  const customerErrorCount = new Map<number, Set<string>>();
  for (const row of input.requestErrors) {
    if (row.account_id === null || row.account_id === undefined || !row.request_id) continue;
    const id = row.account_id;
    customerErrorCount.set(id, new Set([...(customerErrorCount.get(id) ?? []), row.request_id]));
    const attribution = customerErrorAttribution(row);
    if (attribution.scoreable) scoreableByAccount.set(id, new Set([...(scoreableByAccount.get(id) ?? []), row.request_id]));
    else {
      const reasons = excludedByAccount.get(id) ?? new Map<string, number>();
      reasons.set(attribution.reason, (reasons.get(attribution.reason) ?? 0) + 1);
      excludedByAccount.set(id, reasons);
    }
  }

  const finalStatus = new Map<string, number>();
  const failover = new Map<number, Set<string>>();
  const forward = new Map<number, Set<string>>();
  const temp = new Map<number, number>();
  const retries = new Map<number, number>();
  const upstreamStatuses = new Map<number, Map<number, number>>();
  for (const log of input.systemLogs) {
    if (!groupMatches(log, input.group.id)) continue;
    const id = accountId(log);
    const request = requestId(log);
    const message = log.message ?? "";
    if (message.includes(policyMarkers.completed) && request) {
      const status = numeric(extra(log).status_code);
      if (status !== null) finalStatus.set(request, status);
    }
    if (id === null) continue;
    if (message.includes(policyMarkers.temp)) temp.set(id, (temp.get(id) ?? 0) + 1);
    if ((message.includes(policyMarkers.retryOpenAI) || message.includes(policyMarkers.retryGateway))) retries.set(id, (retries.get(id) ?? 0) + 1);
    const eventGroupId = numeric(extra(log).group_id);
    if (request && eventGroupId === input.group.id && message.includes(policyMarkers.failover)) {
      failover.set(id, new Set([...(failover.get(id) ?? []), request]));
      const status = numeric(extra(log).upstream_status);
      if (status !== null) {
        const buckets = upstreamStatuses.get(id) ?? new Map<number, number>();
        buckets.set(status, (buckets.get(status) ?? 0) + 1);
        upstreamStatuses.set(id, buckets);
      }
    }
    if (request && eventGroupId === input.group.id && message.includes(policyMarkers.forward)) forward.set(id, new Set([...(forward.get(id) ?? []), request]));
  }

  const availabilityAccounts = Object.values(record(input.availability.data.account)).map(record);
  const availabilityByAccount = new Map<number, Row>();
  for (const value of availabilityAccounts) {
    const id = numeric(value.account_id);
    if (id !== null && numeric(value.group_id) === input.group.id) availabilityByAccount.set(id, value);
  }
  const availabilityGroups = record(input.availability.data.group);
  const availabilityGroup = record(availabilityGroups[String(input.group.id)] ?? availabilityGroups[input.group.id]);
  const concurrencyGroups = record(input.concurrency.data.group);
  const concurrencyGroup = record(concurrencyGroups[String(input.group.id)] ?? concurrencyGroups[input.group.id]);

  const accountRows = input.accounts.map((account): Row => {
    const usages = usageByAccount.get(account.id) ?? [];
    const streams = usages.filter((row) => row.stream);
    const ttft = streams.flatMap((row) => row.first_token_ms === null ? [] : [row.first_token_ms]);
    const durations = usages.flatMap((row) => row.duration_ms === null ? [] : [row.duration_ms]);
    const scoreable = scoreableByAccount.get(account.id) ?? new Set<string>();
    const failed = new Set([...(failover.get(account.id) ?? []), ...(forward.get(account.id) ?? []), ...scoreable]);
    const successRequests = usages.length;
    const failureRequests = failed.size;
    const attempts = successRequests + failureRequests;
    const failureRate = attempts > 0 ? Math.round(failureRequests / attempts * 1_000_000) / 1_000_000 : null;
    const ttftP95Ms = percentile(ttft, 0.95);
    const reliability = failureRate === null ? null : Math.round(60 * (1 - Math.min(Math.max(failureRate, 0), 0.2) / 0.2) * 100) / 100;
    const latency = ttft.length < 5 || ttftP95Ms === null ? null : Math.round(25 * (1 - Math.min(Math.max(ttftP95Ms - 10_000, 0), 170_000) / 170_000) * 100) / 100;
    const nativeAvailability = availabilityByAccount.get(account.id)?.is_available;
    const currentlyAvailable = typeof nativeAvailability === "boolean"
      ? nativeAvailability
      : account.status === "active" && account.schedulable !== false;
    const availability = currentlyAvailable ? 15 : account.status === "active" ? 8 : 0;
    const availableWeight = (reliability === null ? 0 : 60) + (latency === null ? 0 : 25) + 15;
    const score = attempts > 0 ? Math.round(((reliability ?? 0) + (latency ?? 0) + availability) / availableWeight * 1_000) / 10 : null;
    const comparable = attempts >= 10 && ttft.length >= 5;
    const accountGrade = grade(score, comparable, attempts);
    const failoverIds = failover.get(account.id) ?? new Set<string>();
    const failoverRecovered = [...failoverIds].filter((id) => (finalStatus.get(id) ?? 999) < 400).length;
    const failoverFailed = [...failoverIds].filter((id) => (finalStatus.get(id) ?? 0) >= 400).length;
    const models = new Map<string, number>();
    for (const usage of usages) models.set(usage.model || "unknown", (models.get(usage.model || "unknown") ?? 0) + 1);
    const amount = usages.reduce((sum, row) => sum + (numeric(row.actual_cost) ?? 0), 0);
    const rate = costRate(account.name);
    const reasons = [
      ...(failureRate !== null && failureRate >= 0.1 ? ["failure-rate>=10%"] : failureRate !== null && failureRate >= 0.03 ? ["failure-rate>=3%"] : []),
      ...(failoverIds.size > 0 ? ["upstream-failover-triggered"] : []),
      ...(!currentlyAvailable ? ["currently-unavailable"] : []),
      ...(ttft.length < 5 ? ["ttft-evidence-insufficient"] : []),
      ...(attempts < 10 ? ["request-evidence-insufficient"] : []),
    ];
    return {
      accountId: account.id,
      accountName: account.name,
      status: account.status,
      schedulable: account.schedulable,
      currentlyAvailable,
      priority: account.priority,
      priorityOrder: "lower-is-higher",
      score,
      grade: accountGrade,
      assessment: ({ A: "preferred", B: "healthy", C: "watch", D: "degraded", E: "poor" } as Row)[accountGrade] ?? "insufficient-evidence",
      confidence: attempts >= 50 && ttft.length >= 20 ? "high" : attempts >= 10 && ttft.length >= 5 ? "medium" : "low",
      scoreComparable: comparable,
      observedAttempts: attempts,
      successRequests,
      failureRequests,
      failureRate,
      streamSuccessRequests: streams.length,
      firstTokenSamples: ttft.length,
      firstTokenCoverage: streams.length > 0 ? Math.round(ttft.length / streams.length * 1_000_000) / 1_000_000 : null,
      ttftP50Ms: percentile(ttft, 0.5),
      ttftP95Ms,
      ttftP99Ms: percentile(ttft, 0.99),
      ttftMaxMs: ttft.length ? Math.max(...ttft) : null,
      durationP95Ms: percentile(durations, 0.95),
      modelBuckets: [...models].sort((left, right) => right[1] - left[1]).slice(0, 8).map(([model, count]) => ({ model, count })),
      customerErrorRequests: customerErrorCount.get(account.id)?.size ?? 0,
      scoreableUpstreamErrorRequests: scoreable.size,
      excludedNonUpstreamErrorRequests: [...(excludedByAccount.get(account.id)?.values() ?? [])].reduce((sum, value) => sum + value, 0),
      excludedReasonBuckets: [...(excludedByAccount.get(account.id) ?? [])].map(([reason, count]) => ({ reason, count })),
      usage: {
        requestCount: usages.length,
        tokenCount: usages.reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0),
        apiAmountUsd: Math.round(amount * 100_000_000) / 100_000_000,
        costRateCnyPerApiUsd: rate,
        upstreamCostCny: rate === null ? null : Math.round(amount * rate * 100_000_000) / 100_000_000,
      },
      failoverRequests: failoverIds.size,
      failoverRecovered,
      failoverFailed,
      failoverOutcomeMissing: failoverIds.size - failoverRecovered - failoverFailed,
      sameAccountRetryEvents: retries.get(account.id) ?? 0,
      tempUnschedulableEvents: temp.get(account.id) ?? 0,
      forwardFailedRequests: forward.get(account.id)?.size ?? 0,
      upstreamStatusBuckets: [...(upstreamStatuses.get(account.id) ?? [])].sort((left, right) => left[0] - right[0]).map(([statusCode, count]) => ({ statusCode, count })),
      scoreComponents: { reliability, latency, availability, availableWeight },
      reasons,
      usageStatus: "available",
      usageReason: null,
    };
  });

  const overview = input.overview;
  const requestCount = numeric(overview.request_count_total) ?? 0;
  const errorCount = numeric(overview.error_count_total) ?? 0;
  const upstreamErrorCount = [overview.upstream_error_count_excl_429_529, overview.upstream_429_count, overview.upstream_529_count]
    .reduce((sum: number, value) => sum + (numeric(value) ?? 0), 0);
  const ttftOverview = overview.ttft && typeof overview.ttft === "object" ? overview.ttft as Row : {};
  const durationOverview = overview.duration && typeof overview.duration === "object" ? overview.duration as Row : {};
  const unavailableAccountCount = numeric(availabilityGroup.total_accounts) !== null && numeric(availabilityGroup.available_count) !== null
    ? Math.max(0, Number(availabilityGroup.total_accounts) - Number(availabilityGroup.available_count))
    : [...availabilityByAccount.values()].filter((value) => value.is_available === false).length;
  return {
    group: {
      groupId: input.group.id,
      groupName: input.group.name,
      platform: input.group.platform,
      status: input.group.status,
      requestCount,
      errorCount,
      errorRate: numeric(overview.error_rate),
      upstreamErrorCount,
      upstreamErrorRate: numeric(overview.upstream_error_rate),
      businessLimitedCount: numeric(overview.business_limited_count) ?? 0,
      ttftP99Ms: numeric(ttftOverview.p99_ms),
      durationP99Ms: numeric(durationOverview.p99_ms),
      totalAccounts: numeric(availabilityGroup.total_accounts),
      availableCount: numeric(availabilityGroup.available_count),
      rateLimitCount: numeric(availabilityGroup.rate_limit_count),
      errorAccountCount: numeric(availabilityGroup.error_count),
      unavailableAccountCount,
      currentInUse: numeric(concurrencyGroup.current_in_use),
      maxCapacity: numeric(concurrencyGroup.max_capacity),
      waitingInQueue: numeric(concurrencyGroup.waiting_in_queue),
      needsAttention: errorCount > 0 || upstreamErrorCount > 0 || unavailableAccountCount > 0,
      opsStatus: {
        overview: "available",
        accountAvailability: input.availability.status,
        concurrency: input.concurrency.status,
      },
    },
    accounts: accountRows,
    collection: {
      mode: "nc01-native-api-local-aggregation",
      accountCount: input.accounts.length,
      usageRows: input.usage.length,
      requestErrorRows: input.requestErrors.length,
      policyEventRows: input.systemLogs.length,
      accountAvailabilityStatus: input.availability.status,
      concurrencyStatus: input.concurrency.status,
    },
  };
}
