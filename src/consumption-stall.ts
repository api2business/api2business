import { createHash } from "node:crypto";
import type { ObservabilityConfig } from "./observability-config";
import { audioRequestSql } from "./scoring-error-policy";

type Row = Record<string, unknown>;

export type ConsumptionStallClassification =
  | "healthy"
  | "consumption-stalled"
  | "watch"
  | "demand-insufficient"
  | "excluded";

export type ConsumptionStallWallet = {
  walletKey: string;
  accountIds: number[];
  platforms: string[];
  remainingUsd: number | null;
  state: string;
  sourceAt: string | null;
  freshness: string;
};

export type ConsumptionStallAccountFact = {
  accountId: number;
  platform: string;
  status: string;
  schedulable: boolean;
  priority: number;
  createdAt: string | null;
  baseUrl: string;
  groupIds: number[];
  modelMappingKeys: string[];
  tempUnschedulableUntil: string | null;
  rateLimitResetAt: string | null;
  overloadUntil: string | null;
  expiresAt: string | null;
  currentRecords: number;
  previousRecords: number;
  currentCostUsd: number | null;
  previousCostUsd: number | null;
  currentCostKnownRecords: number;
  previousCostKnownRecords: number;
  currentProbeUsage: number;
  currentProbeErrors: number;
  currentLastUsedAt: string | null;
  previousLastUsedAt: string | null;
};

export type ConsumptionStallWalletAccount = {
  id: number;
  active: boolean;
  type: "apikey";
  base_url: string;
  platform: string;
};

export type ConsumptionStallDemandFact = {
  groupId: number;
  platform: string;
  window: "current" | "previous";
  model: string;
  requests: number;
};

export type ConsumptionStallRecord = {
  accountId: number;
  walletKey: string;
  platform: string;
  priority: number;
  status: string;
  classification: ConsumptionStallClassification;
  reasonCodes: string[];
  groupIds: number[];
  modelMappingKeys: string[];
  balanceUsd: number | null;
  balanceFreshness: string;
  balanceSourceAt: string | null;
  current: { records: number; costUsd: number | null; lastUsedAt: string | null };
  previous: { records: number; costUsd: number | null; lastUsedAt: string | null };
  compatibleDemand: { currentRequests: number; previousRequests: number; models: string[] };
  platformDemand: { currentRequests: number; previousRequests: number };
  consumptionDropPercent: number | null;
  platformTrafficDropPercent: number | null;
  probe: { usage: number; errors: number };
};

export type ConsumptionStallAlert = {
  alertId: string;
  fingerprint: string;
  kind: "consumption-stalled";
  lifecycle: "firing";
  severity: "warning";
  title: string;
  summary: string;
  walletKey: string;
  platform: string;
  accountIds: number[];
  groupIds: number[];
  balanceUsd: number | null;
  currentCostUsd: number;
  previousCostUsd: number;
  consumptionDropPercent: number;
  compatibleDemand: { currentRequests: number; previousRequests: number };
  platformDemand: { currentRequests: number; previousRequests: number };
  observedAt: string;
  recoveryCriteria: string;
  rootCauseHints: string[];
};

export type ConsumptionStallReport = {
  ok: true;
  version: 1;
  observedAt: string;
  window: { start: string; end: string; boundary: "[start,end)"; seconds: number };
  previousWindow: { start: string; end: string; boundary: "[start,end)"; seconds: number };
  config: {
    dropPercent: number;
    minimumDemandRequests: number;
    maximumTrafficDropPercent: number;
  };
  summary: {
    scannedAccounts: number;
    healthy: number;
    consumptionStalled: number;
    watch: number;
    demandInsufficient: number;
    excluded: number;
    alerts: number;
  };
  records: ConsumptionStallRecord[];
  alerts: ConsumptionStallAlert[];
  valuesPrinted: false;
};

export const consumptionStallSql = `
WITH probe_keys AS (
  SELECT k.id FROM api_keys k LEFT JOIN users u ON u.id=k.user_id
  WHERE u.email='monitor-user@sub2api.platform-infra.local'
    OR LOWER(COALESCE(k.name,'')) LIKE 'api2business-probe-%'
), probe_accounts AS (
  SELECT k.id AS api_key_id,
    SUBSTRING(k.name FROM '^api2business-probe-([0-9]+)$')::int AS account_id
  FROM api_keys k LEFT JOIN users u ON u.id=k.user_id
  WHERE (u.email='monitor-user@sub2api.platform-infra.local'
    OR LOWER(COALESCE(k.name,'')) LIKE 'api2business-probe-%')
    AND k.name ~ '^api2business-probe-[0-9]+$'
), probe_window AS (
  SELECT p.account_id,
    COUNT(*) FILTER (WHERE w.kind='usage')::int AS usage_count,
    COUNT(*) FILTER (WHERE w.kind='error')::int AS error_count
  FROM (
    SELECT api_key_id,'usage' AS kind FROM usage_logs
    WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
    UNION ALL
    SELECT api_key_id,'error' AS kind FROM ops_error_logs
    WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
  ) w
  JOIN probe_accounts p ON p.api_key_id=w.api_key_id
  GROUP BY p.account_id
), real_usage AS (
  SELECT u.account_id, u.group_id, u.created_at, u.actual_cost,
    COALESCE(NULLIF(TRIM(u.requested_model),''),NULLIF(TRIM(u.model),''),NULLIF(TRIM(u.upstream_model),''),'unknown') AS model,
    CASE WHEN u.created_at >= $2::timestamptz THEN 'current' ELSE 'previous' END AS window_key
  FROM usage_logs u
  LEFT JOIN probe_keys p ON p.id=u.api_key_id
  LEFT JOIN groups g ON g.id=u.group_id
  WHERE u.created_at >= $1::timestamptz AND u.created_at < $3::timestamptz
    AND p.id IS NULL
    AND LOWER(COALESCE(g.name,'')) NOT LIKE 'api2business-probe-%'
    AND NOT ${audioRequestSql("u")}
), account_usage AS (
  SELECT account_id,
    COUNT(*) FILTER (WHERE window_key='current')::int AS current_records,
    COUNT(*) FILTER (WHERE window_key='previous')::int AS previous_records,
    SUM(actual_cost) FILTER (WHERE window_key='current' AND actual_cost>=0) AS current_cost_usd,
    SUM(actual_cost) FILTER (WHERE window_key='previous' AND actual_cost>=0) AS previous_cost_usd,
    COUNT(*) FILTER (WHERE window_key='current' AND actual_cost IS NOT NULL AND actual_cost>=0)::int AS current_cost_known_records,
    COUNT(*) FILTER (WHERE window_key='previous' AND actual_cost IS NOT NULL AND actual_cost>=0)::int AS previous_cost_known_records,
    MAX(created_at) FILTER (WHERE window_key='current') AS current_last_used_at,
    MAX(created_at) FILTER (WHERE window_key='previous') AS previous_last_used_at
  FROM real_usage GROUP BY account_id
), account_group_ids AS (
  SELECT account_id,COALESCE(array_agg(DISTINCT group_id),'{}') AS group_ids
  FROM account_groups WHERE group_id IS NOT NULL GROUP BY account_id
), account_rows AS (
  SELECT jsonb_build_object(
    'accountId',a.id,
    'platform',COALESCE(a.platform,'unknown'),
    'status',COALESCE(a.status,'unknown'),
    'schedulable',COALESCE(a.schedulable,false),
    'priority',a.priority,
    'createdAt',a.created_at,
    'baseUrl',RTRIM(COALESCE(a.credentials->>'base_url',''),'/'),
    'groupIds',COALESCE(ag.group_ids,'{}'),
    'modelMappingKeys',COALESCE(ARRAY(
      SELECT jsonb_object_keys(CASE WHEN jsonb_typeof(a.credentials->'model_mapping')='object'
        THEN a.credentials->'model_mapping' ELSE '{}'::jsonb END)
    ),'{}'),
    'tempUnschedulableUntil',a.temp_unschedulable_until,
    'rateLimitResetAt',a.rate_limit_reset_at,
    'overloadUntil',a.overload_until,
    'expiresAt',a.expires_at,
    'currentRecords',COALESCE(au.current_records,0),
    'previousRecords',COALESCE(au.previous_records,0),
    'currentCostUsd',CASE WHEN COALESCE(au.current_records,0)=0 THEN 0 ELSE au.current_cost_usd END,
    'previousCostUsd',CASE WHEN COALESCE(au.previous_records,0)=0 THEN 0 ELSE au.previous_cost_usd END,
    'currentCostKnownRecords',COALESCE(au.current_cost_known_records,0),
    'previousCostKnownRecords',COALESCE(au.previous_cost_known_records,0),
    'currentProbeUsage',COALESCE(pw.usage_count,0),
    'currentProbeErrors',COALESCE(pw.error_count,0),
    'currentLastUsedAt',au.current_last_used_at,
    'previousLastUsedAt',au.previous_last_used_at
  ) AS row
  FROM accounts a
  LEFT JOIN account_usage au ON au.account_id=a.id
  LEFT JOIN account_group_ids ag ON ag.account_id=a.id
  LEFT JOIN probe_window pw ON pw.account_id=a.id
  WHERE a.deleted_at IS NULL AND LOWER(a.type)='apikey'
), demand_rows AS (
  SELECT jsonb_build_object(
    'groupId',u.group_id,
    'platform',COALESCE(a.platform,'unknown'),
    'window',u.window_key,
    'model',u.model,
    'requests',COUNT(*)::int
  ) AS row
  FROM real_usage u LEFT JOIN accounts a ON a.id=u.account_id
  WHERE u.group_id IS NOT NULL
  GROUP BY u.group_id,COALESCE(a.platform,'unknown'),u.window_key,u.model
)
SELECT jsonb_build_object(
  'accounts',COALESCE((SELECT jsonb_agg(row) FROM account_rows),'[]'::jsonb),
  'demand',COALESCE((SELECT jsonb_agg(row) FROM demand_rows),'[]'::jsonb)
) AS facts`;

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function time(value: unknown): number | null {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueNumbers(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value !== ""))].sort();
}

function walletMap(wallets: ConsumptionStallWallet[]): Map<number, ConsumptionStallWallet> {
  const result = new Map<number, ConsumptionStallWallet>();
  for (const wallet of wallets) for (const accountId of wallet.accountIds) result.set(accountId, wallet);
  return result;
}

function future(after: string | null, now: number): boolean {
  const parsed = time(after);
  return parsed !== null && parsed > now;
}

function accountUnavailable(account: ConsumptionStallAccountFact, now: number): string | null {
  if (account.status !== "active") return `status-${account.status}`;
  if (!account.schedulable) return "not-schedulable";
  if (future(account.tempUnschedulableUntil, now)) return "temporarily-unschedulable";
  if (future(account.rateLimitResetAt, now)) return "rate-limited";
  if (future(account.overloadUntil, now)) return "overloaded";
  const expires = time(account.expiresAt);
  if (expires !== null && expires <= now) return "expired";
  return null;
}

function accountSupportsModel(account: ConsumptionStallAccountFact, model: string): boolean {
  if (account.modelMappingKeys.length === 0) return true;
  return account.modelMappingKeys.includes("*") || account.modelMappingKeys.includes(model);
}

function demandFor(
  account: ConsumptionStallAccountFact,
  demand: ConsumptionStallDemandFact[],
): { currentRequests: number; previousRequests: number; models: string[] } {
  const groups = new Set(account.groupIds);
  const models = new Set<string>();
  let currentRequests = 0;
  let previousRequests = 0;
  for (const item of demand) {
    if (item.platform !== account.platform || !groups.has(item.groupId) || !accountSupportsModel(account, item.model)) continue;
    if (item.window === "current") currentRequests += item.requests;
    else previousRequests += item.requests;
    models.add(item.model);
  }
  return { currentRequests, previousRequests, models: [...models].sort() };
}

function platformDemandFor(
  account: ConsumptionStallAccountFact,
  demand: ConsumptionStallDemandFact[],
): { currentRequests: number; previousRequests: number } {
  let currentRequests = 0;
  let previousRequests = 0;
  for (const item of demand) {
    if (item.platform !== account.platform) continue;
    if (item.window === "current") currentRequests += item.requests;
    else previousRequests += item.requests;
  }
  return { currentRequests, previousRequests };
}

function dropPercent(previous: number, current: number): number | null {
  if (previous <= 0) return null;
  return Math.max(0, (previous - current) / previous * 100);
}

function knownCost(records: number, knownRecords: number, value: number | null): number | null {
  if (records === 0) return 0;
  if (knownRecords !== records || value === null) return null;
  return Math.max(0, value);
}

export function evaluateConsumptionStalls(input: {
  accounts: ConsumptionStallAccountFact[];
  demand: ConsumptionStallDemandFact[];
  wallets: ConsumptionStallWallet[];
  config: ObservabilityConfig;
  excludedWalletKeys: string[];
  now: string;
  window: ConsumptionStallReport["window"];
  previousWindow: ConsumptionStallReport["previousWindow"];
}): ConsumptionStallReport {
  const nowMs = Date.parse(input.now);
  const walletByAccount = walletMap(input.wallets);
  const excludedWallets = new Set(input.excludedWalletKeys);
  const records: ConsumptionStallRecord[] = [];
  const counts = { healthy: 0, consumptionStalled: 0, watch: 0, demandInsufficient: 0, excluded: 0 };
  for (const account of input.accounts) {
    const wallet = walletByAccount.get(account.accountId);
    const walletKey = wallet?.walletKey ?? `unknown-account:${account.accountId}`;
    const currentCost = knownCost(account.currentRecords, account.currentCostKnownRecords, account.currentCostUsd);
    const previousCost = knownCost(account.previousRecords, account.previousCostKnownRecords, account.previousCostUsd);
    const demand = demandFor(account, input.demand);
    const platformDemand = platformDemandFor(account, input.demand);
    const consumptionDropPercent = currentCost === null || previousCost === null ? null : dropPercent(previousCost, currentCost);
    const platformTrafficDropPercent = dropPercent(platformDemand.previousRequests, platformDemand.currentRequests);
    const reasonCodes: string[] = [];
    let classification: ConsumptionStallClassification = "healthy";

    if (excludedWallets.has(walletKey)) {
      classification = "excluded";
      reasonCodes.push("wallet-excluded");
    } else if (!wallet || wallet.state !== "known" || wallet.remainingUsd === null || wallet.remainingUsd <= 0) {
      classification = "watch";
      reasonCodes.push(!wallet ? "wallet-unknown" : wallet.remainingUsd === null ? "balance-unknown" : "balance-not-positive");
    } else if (wallet.freshness !== "fresh") {
      classification = "watch";
      reasonCodes.push(`balance-${wallet.freshness}`);
    }

    const unavailable = accountUnavailable(account, nowMs);
    if (classification === "healthy" && unavailable) {
      classification = "watch";
      reasonCodes.push(`account-${unavailable}`);
    }
    const createdAt = time(account.createdAt);
    if (classification === "healthy" && (createdAt === null || createdAt > Date.parse(input.previousWindow.start))) {
      classification = "watch";
      reasonCodes.push("insufficient-history");
    }
    if (classification === "healthy" && account.groupIds.length === 0) {
      classification = "demand-insufficient";
      reasonCodes.push("no-compatible-groups");
    }
    if (classification === "healthy" && (demand.currentRequests < input.config.consumptionStallMinimumDemandRequests
      || demand.previousRequests < input.config.consumptionStallMinimumDemandRequests)) {
      classification = "demand-insufficient";
      reasonCodes.push("insufficient-compatible-demand");
    }
    if (classification === "healthy" && platformDemand.previousRequests > 0
      && platformTrafficDropPercent !== null
      && platformTrafficDropPercent > input.config.consumptionStallMaxTrafficDropPercent) {
      classification = "demand-insufficient";
      reasonCodes.push("platform-traffic-dropped");
    }
    if (classification === "healthy" && currentCost === 0
      && account.currentProbeUsage === 0 && account.currentProbeErrors > 0) {
      classification = "watch";
      reasonCodes.push("probe-unhealthy");
    }
    if (classification === "healthy" && (currentCost === null || previousCost === null)) {
      classification = "watch";
      reasonCodes.push("cost-incomplete");
    }
    if (classification === "healthy" && currentCost !== null && previousCost !== null) {
      const bothZero = currentCost === 0 && previousCost === 0;
      const dropped = previousCost > 0 && (consumptionDropPercent ?? 0) >= input.config.consumptionStallDropPercent;
      if (bothZero || dropped) {
        classification = "consumption-stalled";
        reasonCodes.push(bothZero ? "zero-consumption-both-windows" : "consumption-drop-exceeded");
      } else if (currentCost === 0 || previousCost === 0) {
        classification = "watch";
        reasonCodes.push("single-window-zero");
      }
    }

    if (classification === "healthy") {
      counts.healthy++;
      continue;
    }
    counts[classification === "consumption-stalled" ? "consumptionStalled" : classification === "demand-insufficient" ? "demandInsufficient" : classification]++;
    records.push({
      accountId: account.accountId,
      walletKey,
      platform: account.platform,
      priority: account.priority,
      status: account.status,
      classification,
      reasonCodes,
      groupIds: account.groupIds,
      modelMappingKeys: account.modelMappingKeys,
      balanceUsd: wallet?.remainingUsd ?? null,
      balanceFreshness: wallet?.freshness ?? "unknown",
      balanceSourceAt: wallet?.sourceAt ?? null,
      current: { records: account.currentRecords, costUsd: currentCost, lastUsedAt: account.currentLastUsedAt },
      previous: { records: account.previousRecords, costUsd: previousCost, lastUsedAt: account.previousLastUsedAt },
      compatibleDemand: demand,
      platformDemand,
      consumptionDropPercent,
      platformTrafficDropPercent,
      probe: { usage: account.currentProbeUsage, errors: account.currentProbeErrors },
    });
  }

  const alertsByKey = new Map<string, ConsumptionStallAlert>();
  for (const record of records.filter((item) => item.classification === "consumption-stalled")) {
    const key = `${record.walletKey}\n${record.platform}`;
    const existing = alertsByKey.get(key);
    if (existing) {
      existing.accountIds.push(record.accountId);
      existing.groupIds = [...new Set([...existing.groupIds, ...record.groupIds])].sort((a, b) => a - b);
      existing.currentCostUsd += record.current.costUsd ?? 0;
      existing.previousCostUsd += record.previous.costUsd ?? 0;
      existing.consumptionDropPercent = dropPercent(existing.previousCostUsd, existing.currentCostUsd) ?? 100;
      continue;
    }
    const fingerprint = createHash("sha256")
      .update(`consumption-stalled\n${record.walletKey}\n${record.platform}`)
      .digest("hex")
      .slice(0, 24);
    alertsByKey.set(key, {
      alertId: `stall_${fingerprint}`,
      fingerprint,
      kind: "consumption-stalled",
      lifecycle: "firing",
      severity: "warning",
      title: `${record.walletKey}（${record.platform}）连续两窗有需求但无消耗`,
      summary: "钱包余额新鲜且账号可调度，兼容需求连续两个窗口存在，但真实用户消耗为零或降幅超过配置阈值。",
      walletKey: record.walletKey,
      platform: record.platform,
      accountIds: [record.accountId],
      groupIds: [...record.groupIds],
      balanceUsd: record.balanceUsd,
      currentCostUsd: record.current.costUsd ?? 0,
      previousCostUsd: record.previous.costUsd ?? 0,
      consumptionDropPercent: record.consumptionDropPercent ?? 100,
      compatibleDemand: { ...record.compatibleDemand },
      platformDemand: { ...record.platformDemand },
      observedAt: input.now,
      recoveryCriteria: "同一钱包与平台连续一轮不再满足两窗零消耗或降幅阈值，并确认真实用户需求仍存在。",
      rootCauseHints: [
        "先核对余额与产出缓存是否陈旧、最新失败样本是否覆盖成功余额。",
        "核对账号优先级、冷却、并发、容量、模型映射、API-key 权限和 V2 调度计划。",
        "只有真实用户失败或可感知不可用才升级事故；低优先级回填不能替代告警生命周期。",
      ],
    });
  }
  for (const alert of alertsByKey.values()) alert.accountIds.sort((a, b) => a - b);
  const alerts = [...alertsByKey.values()].sort((left, right) => left.alertId.localeCompare(right.alertId));
  return {
    ok: true,
    version: 1,
    observedAt: input.now,
    window: input.window,
    previousWindow: input.previousWindow,
    config: {
      dropPercent: input.config.consumptionStallDropPercent,
      minimumDemandRequests: input.config.consumptionStallMinimumDemandRequests,
      maximumTrafficDropPercent: input.config.consumptionStallMaxTrafficDropPercent,
    },
    summary: {
      scannedAccounts: input.accounts.length,
      healthy: counts.healthy,
      consumptionStalled: counts.consumptionStalled,
      watch: counts.watch,
      demandInsufficient: counts.demandInsufficient,
      excluded: counts.excluded,
      alerts: alerts.length,
    },
    records: records.sort((left, right) => left.walletKey.localeCompare(right.walletKey) || left.accountId - right.accountId),
    alerts,
    valuesPrinted: false,
  };
}

export function parseConsumptionStallAccountFacts(value: unknown): ConsumptionStallAccountFact[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item) => ({
    accountId: number(item.accountId),
    platform: String(item.platform ?? "unknown"),
    status: String(item.status ?? "unknown"),
    schedulable: item.schedulable === true,
    priority: number(item.priority),
    createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
    baseUrl: String(item.baseUrl ?? ""),
    groupIds: uniqueNumbers(item.groupIds),
    modelMappingKeys: uniqueStrings(item.modelMappingKeys),
    tempUnschedulableUntil: typeof item.tempUnschedulableUntil === "string" ? item.tempUnschedulableUntil : null,
    rateLimitResetAt: typeof item.rateLimitResetAt === "string" ? item.rateLimitResetAt : null,
    overloadUntil: typeof item.overloadUntil === "string" ? item.overloadUntil : null,
    expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : null,
    currentRecords: number(item.currentRecords),
    previousRecords: number(item.previousRecords),
    currentCostUsd: item.currentCostUsd === null || item.currentCostUsd === undefined ? null : number(item.currentCostUsd),
    previousCostUsd: item.previousCostUsd === null || item.previousCostUsd === undefined ? null : number(item.previousCostUsd),
    currentCostKnownRecords: number(item.currentCostKnownRecords),
    previousCostKnownRecords: number(item.previousCostKnownRecords),
    currentProbeUsage: number(item.currentProbeUsage),
    currentProbeErrors: number(item.currentProbeErrors),
    currentLastUsedAt: typeof item.currentLastUsedAt === "string" ? item.currentLastUsedAt : null,
    previousLastUsedAt: typeof item.previousLastUsedAt === "string" ? item.previousLastUsedAt : null,
  }));
}

export function consumptionStallWalletAccounts(
  accounts: ConsumptionStallAccountFact[],
): ConsumptionStallWalletAccount[] {
  return accounts.map((account) => ({
    id: account.accountId,
    active: account.status === "active",
    type: "apikey",
    base_url: account.baseUrl,
    platform: account.platform,
  }));
}

export function parseConsumptionStallDemandFacts(value: unknown): ConsumptionStallDemandFact[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item))).flatMap((item) => {
    const groupId = number(item.groupId);
    const window = item.window === "current" ? "current" : item.window === "previous" ? "previous" : null;
    if (!Number.isSafeInteger(groupId) || groupId <= 0 || window === null) return [];
    return [{
      groupId,
      platform: String(item.platform ?? "unknown"),
      window,
      model: String(item.model ?? "unknown"),
      requests: number(item.requests),
    }];
  });
}
