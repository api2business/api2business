import { expect, test } from "bun:test";
import { consumptionStallSql, evaluateConsumptionStalls, parseConsumptionStallDemandFacts, type ConsumptionStallAccountFact, type ConsumptionStallDemandFact, type ConsumptionStallWallet } from "./consumption-stall";
import { parseObservabilityConfig } from "./observability-config";

const config = parseObservabilityConfig({
  sub2apiSuccessPercent: 95,
  sub2apiTtftP95Ms: 30000,
  api2businessNon5xxPercent: 99.9,
  api2businessLatencyP95Ms: 3000,
  walletFreshnessSeconds: 3600,
  retentionDays: 30,
  probeCostDailyBudgetCny: null,
  probeCostTrendFactor: 1.5,
  consumptionStallDropPercent: 90,
  consumptionStallMinimumDemandRequests: 1,
  consumptionStallMaxTrafficDropPercent: 50,
})!;

const window = { start: "2026-11-13T10:00:00.000Z", end: "2026-11-13T12:00:00.000Z", boundary: "[start,end)" as const, seconds: 7200 };
const previousWindow = { start: "2026-11-13T08:00:00.000Z", end: "2026-11-13T10:00:00.000Z", boundary: "[start,end)" as const, seconds: 7200 };

function account(overrides: Partial<ConsumptionStallAccountFact> = {}): ConsumptionStallAccountFact {
  return {
    accountId: 37,
    platform: "openai",
    status: "active",
    schedulable: true,
    priority: 300,
    createdAt: "2026-09-01T00:00:00Z",
    baseUrl: "https://www.xiaobaishu.org",
    groupIds: [2],
    modelMappingKeys: ["gpt-5.6-sol"],
    tempUnschedulableUntil: null,
    rateLimitResetAt: null,
    overloadUntil: null,
    expiresAt: null,
    currentRecords: 0,
    previousRecords: 0,
    currentCostUsd: 0,
    previousCostUsd: 0,
    currentCostKnownRecords: 0,
    previousCostKnownRecords: 0,
    currentProbeUsage: 0,
    currentProbeErrors: 0,
    currentLastUsedAt: null,
    previousLastUsedAt: null,
    ...overrides,
  };
}

function wallet(overrides: Partial<ConsumptionStallWallet> = {}): ConsumptionStallWallet {
  return {
    walletKey: "https://www.xiaobaishu.org",
    accountIds: [37],
    platforms: ["openai"],
    remainingUsd: 44.76,
    state: "known",
    sourceAt: "2026-11-13T11:59:30Z",
    freshness: "fresh",
    ...overrides,
  };
}

function demand(current = 700, previous = 400): ConsumptionStallDemandFact[] {
  return [
    { groupId: 2, platform: "openai", window: "current", model: "gpt-5.6-sol", requests: current },
    { groupId: 2, platform: "openai", window: "previous", model: "gpt-5.6-sol", requests: previous },
  ];
}

function evaluate(accounts: ConsumptionStallAccountFact[], wallets: ConsumptionStallWallet[], demandRows = demand()) {
  return evaluateConsumptionStalls({ accounts, demand: demandRows, wallets, config, excludedWalletKeys: [], now: window.end, window, previousWindow });
}

test("新鲜余额、可调度、两窗有需求且两窗零消耗形成稳定强告警", () => {
  const result = evaluate([account()], [wallet()]);
  expect(result.summary).toMatchObject({ scannedAccounts: 1, consumptionStalled: 1, alerts: 1, healthy: 0 });
  expect(result.records[0]).toMatchObject({
    accountId: 37,
    classification: "consumption-stalled",
    reasonCodes: ["zero-consumption-both-windows"],
    compatibleDemand: { currentRequests: 700, previousRequests: 400 },
  });
  expect(result.alerts[0]).toMatchObject({
    kind: "consumption-stalled",
    lifecycle: "firing",
    accountIds: [37],
    groupIds: [2],
    currentCostUsd: 0,
    previousCostUsd: 0,
  });
  expect(result.alerts[0]?.alertId).toStartWith("stall_");
  expect(evaluate([account()], [wallet()]).alerts[0]?.alertId).toBe(result.alerts[0]?.alertId);
});

test("同一钱包和平台的多个停滞账号聚合为一条告警", () => {
  const result = evaluate([account(), account({ accountId: 39 })], [wallet({ accountIds: [37, 39] })]);
  expect(result.summary.alerts).toBe(1);
  expect(result.alerts[0]?.accountIds).toEqual([37, 39]);
});

test("单窗为零只记 watch，没有兼容需求记 demand-insufficient", () => {
  const oneWindow = evaluate([account({ currentRecords: 1, currentCostUsd: 0.2, currentCostKnownRecords: 1 })], [wallet()]);
  expect(oneWindow.records[0]).toMatchObject({ classification: "watch", reasonCodes: ["single-window-zero"] });
  const noDemand = evaluate([account()], [wallet()], []);
  expect(noDemand.records[0]).toMatchObject({ classification: "demand-insufficient", reasonCodes: ["insufficient-compatible-demand"] });
});

test("余额陈旧、账号不可调度和模型不兼容都不会伪造强停滞", () => {
  expect(evaluate([account()], [wallet({ freshness: "stale" })]).records[0]).toMatchObject({ classification: "watch", reasonCodes: ["balance-stale"] });
  expect(evaluate([account({ schedulable: false })], [wallet()]).records[0]).toMatchObject({ classification: "watch", reasonCodes: ["account-not-schedulable"] });
  const incompatible = evaluate([account({ modelMappingKeys: ["gpt-other"] })], [wallet()]);
  expect(incompatible.records[0]).toMatchObject({ classification: "demand-insufficient", reasonCodes: ["insufficient-compatible-demand"] });
});

test("降幅阈值按边界生效，平台总流量同等下降不触发", () => {
  const dropped = evaluate([account({ previousRecords: 1, previousCostUsd: 10, previousCostKnownRecords: 1, currentRecords: 1, currentCostUsd: 1, currentCostKnownRecords: 1 })], [wallet()]);
  expect(dropped.records[0]).toMatchObject({ classification: "consumption-stalled", reasonCodes: ["consumption-drop-exceeded"] });
  const steady = evaluate([account({ previousRecords: 1, previousCostUsd: 10, previousCostKnownRecords: 1, currentRecords: 1, currentCostUsd: 9, currentCostKnownRecords: 1 })], [wallet()]);
  expect(steady.summary.healthy).toBe(1);
  const trafficDrop = evaluate([account()], [wallet()], [
    { groupId: 2, platform: "openai", window: "current", model: "gpt-5.6-sol", requests: 1 },
    { groupId: 2, platform: "openai", window: "previous", model: "gpt-5.6-sol", requests: 100 },
  ]);
  expect(trafficDrop.records[0]).toMatchObject({ classification: "demand-insufficient", reasonCodes: ["platform-traffic-dropped"] });
});

test("停滞查询显式排除探活与语音，并只读取当前和上一窗口", () => {
  expect(consumptionStallSql).toContain("api2business-probe-%");
  expect(consumptionStallSql).toContain("NOT (");
  expect(consumptionStallSql).toContain("u.created_at >= $1::timestamptz");
  expect(consumptionStallSql).toContain("u.created_at < $3::timestamptz");
  expect(consumptionStallSql).toContain("probe_window");
  expect(consumptionStallSql).toContain("currentProbeErrors");
  expect(parseConsumptionStallDemandFacts([{ groupId: 2, platform: "openai", window: "current", model: "gpt", requests: 7 }]))
    .toEqual([{ groupId: 2, platform: "openai", window: "current", model: "gpt", requests: 7 }]);
});

test("探活全部失败且零消耗归类为 watch，不伪造消耗停滞告警", () => {
  const result = evaluate([account({ currentProbeErrors: 70 })], [wallet()]);
  expect(result.summary).toMatchObject({ consumptionStalled: 0, watch: 1, alerts: 0 });
  expect(result.records[0]).toMatchObject({
    classification: "watch",
    reasonCodes: ["probe-unhealthy"],
    probe: { usage: 0, errors: 70 },
  });
  const healthyProbe = evaluate([account({ currentProbeUsage: 16 })], [wallet()]);
  expect(healthyProbe.records[0]).toMatchObject({ classification: "consumption-stalled" });
});

test("停滞配置有明确默认值并拒绝越界", () => {
  const defaults = parseObservabilityConfig({
    sub2apiSuccessPercent: 95, sub2apiTtftP95Ms: 30000, api2businessNon5xxPercent: 99.9,
    api2businessLatencyP95Ms: 3000, walletFreshnessSeconds: 3600, retentionDays: 30,
    probeCostDailyBudgetCny: null, probeCostTrendFactor: 1.5,
  });
  expect(defaults).toMatchObject({ consumptionStallDropPercent: 90, consumptionStallMinimumDemandRequests: 1, consumptionStallMaxTrafficDropPercent: 50 });
  expect(() => parseObservabilityConfig({ ...config, consumptionStallDropPercent: 101 })).toThrow();
  expect(() => parseObservabilityConfig({ ...config, consumptionStallMinimumDemandRequests: 0 })).toThrow();
});
