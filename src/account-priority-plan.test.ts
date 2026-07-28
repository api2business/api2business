import { expect, test } from "bun:test";
import { buildAccountPriorityPlan } from "./account-priority-plan";
import type { AppConfig } from "./config";

const config = {
  sub2api: {
    priorityPlan: {
      platform: "openai",
      eligibleGroupIds: [2, 3],
      requiredConfidence: "high",
      requireCurrentAvailable: true,
      qualityWeight: 80,
      costWeight: 20,
      pointsPerScore: 10,
      minimumChange: 5,
      minimumPriority: 1,
      maximumPriority: 1000,
      reservePolicies: {},
      procurementAdvice: {
        enabled: true,
        minimumQualityScore: 80,
        valueWeight: 80,
        redundancyWeight: 20,
        recommendationLimit: 3,
        statusAlertLimit: 20,
        maximumRecommendationsPerSupplier: 1,
        minimumSupplierCount: 3,
        maximumSupplierShare: 0.5,
        billingErrorPatterns: ["insufficient account balance", "余额不足"],
      },
    },
    grokPriorityPlan: {
      platform: "grok",
      eligibleGroupIds: [6],
      requiredConfidence: "high",
      requireCurrentAvailable: true,
      qualityWeight: 85,
      costWeight: 15,
      pointsPerScore: 8,
      minimumChange: 5,
      minimumPriority: 1,
      maximumPriority: 1000,
      reservePolicies: {},
      procurementAdvice: {
        enabled: false,
        minimumQualityScore: 80,
        valueWeight: 80,
        redundancyWeight: 20,
        recommendationLimit: 3,
        statusAlertLimit: 20,
        maximumRecommendationsPerSupplier: 1,
        minimumSupplierCount: 3,
        maximumSupplierShare: 0.5,
        billingErrorPatterns: ["insufficient account balance"],
      },
    },
  },
} as AppConfig;

function account(id: number, name: string, score: number, available = true, error = "") {
  return {
    accountId: id,
    accountName: name,
    platform: "openai",
    groupIds: [2, 3],
    confidence: "high",
    currentAvailable: available,
    status: available ? "active" : "error",
    schedulable: available,
    currentError: error,
    score,
    priority: 100 + id,
    observedAttempts: 1000,
    failureRate: 0,
    failoverRate: 0,
    ttftP95Ms: 8000,
    usage: { costRateCnyPerApiUsd: 0.1 },
  };
}

test("priority plan reports billing depletion without scheduling unavailable accounts", () => {
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    account(1, "https://alpha.example pro 0.1", 95, false, "403 Insufficient account balance"),
    account(2, "https://beta.example pro 0.1", 90),
  ] }, config);
  const advice = plan.procurementAdvice as Record<string, any>;
  expect(advice.statusAlerts[0]).toMatchObject({ billingSite: "alpha.example", kind: "billing-depleted", procurementRelevant: true });
  expect(advice.statusAlerts[0]).not.toHaveProperty("accountId");
  expect(advice.recommendations[0]).toMatchObject({ billingSite: "alpha.example", action: "renew-balance" });
  expect(advice.recommendations[0].availableChannelCount).toBe(0);
  expect(plan.priorities).not.toHaveProperty("1");
});

test("reserve policy dynamically lowers priority as weekly quota is depleted", () => {
  const reserveConfig = structuredClone(config);
  reserveConfig.sub2api.priorityPlan.reservePolicies = {
    "2": { lowRemainingThresholdPercent: 20, normalPriorityFloor: 100, lowRemainingPriority: 600 },
  };
  const reserveAccount: Record<string, unknown> = account(2, "stable reserve pro 0.1", 99);
  reserveAccount.weeklyRemainingPercent = 19;
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    account(1, "https://alpha.example plus 0.05", 90),
    reserveAccount,
  ] }, reserveConfig);
  const reserve = (plan.changes as Array<Record<string, unknown>>).find((row) => row.accountId === 2);
  expect(reserve).toMatchObject({
    configuredPriorityFloor: 600,
    priorityFloorApplied: true,
    desiredPriority: 600,
    reservePolicy: {
      weeklyRemainingPercent: 19,
      lowRemainingThresholdPercent: 20,
      mode: "low-remaining-reserve",
    },
  });
  expect(plan.priorities).toMatchObject({ "2": 600 });
});

test("procurement recommendations remain supplier-diverse and do not treat limits as billing", () => {
  const diverseConfig = structuredClone(config);
  diverseConfig.sub2api.priorityPlan.procurementAdvice.recommendationLimit = 4;
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    account(1, "https://alpha.example pro 0.1", 98),
    account(2, "https://alpha.example plus 0.1", 97),
    account(3, "https://beta.example pro 0.1", 94),
    account(4, "https://gamma.example pro 0.1", 92),
    account(5, "https://delta.example pro 0.1", 91, false, "weekly usage limit reached"),
  ] }, diverseConfig);
  const advice = plan.procurementAdvice as Record<string, any>;
  expect(advice.statusAlerts[0]).toMatchObject({ billingSite: "delta.example", kind: "channel-unavailable", procurementRelevant: false });
  expect(new Set(advice.recommendations.map((item: Record<string, unknown>) => item.billingSite)).size).toBe(4);
  expect(advice.recommendations.find((item: Record<string, unknown>) => item.billingSite === "alpha.example")).toMatchObject({
    channelCount: 2,
    qualifiedChannelCount: 2,
    availableChannelCount: 2,
  });
  expect(advice.summary.redundancyStatus).toBe("diversified");
});

test("procurement advice remains available when every account is unavailable", () => {
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    account(1, "https://alpha.example pro 0.1", 95, false, "余额不足"),
  ] }, config);
  const advice = plan.procurementAdvice as Record<string, any>;
  expect(plan.eligibleCount).toBe(0);
  expect(plan.anchorScore).toBeNull();
  expect(plan.priorities).toEqual({});
  expect(advice.recommendations[0]).toMatchObject({ billingSite: "alpha.example", action: "renew-balance" });
});

test("shared-balance channels produce one website-level alert and recommendation", () => {
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    account(1, "https://shared.example plus 0.08", 95, false, "余额不足"),
    account(2, "https://shared.example pro 0.08", 90, false, "余额不足"),
  ] }, config);
  const advice = plan.procurementAdvice as Record<string, any>;
  expect(advice.statusAlerts).toHaveLength(1);
  expect(advice.statusAlerts[0]).toMatchObject({ billingSite: "shared.example", channelCount: 2, availableChannelCount: 0 });
  expect(advice.recommendations).toHaveLength(1);
  expect(advice.recommendations[0]).toMatchObject({ billingSite: "shared.example", channelCount: 2, action: "renew-balance" });
  expect(advice.recommendations[0]).not.toHaveProperty("accountIds");
  expect(Object.keys(plan.priorities as Record<string, number>)).toHaveLength(0);
});

test("codex and grok use independent anchors and merge into one adjustment plan", () => {
  const grokAccount = {
    ...account(10, "https://grok-a.example grok 0.02", 95),
    platform: "grok",
    groupIds: [6],
    priority: 200,
    usage: { costRateCnyPerApiUsd: 0.02 },
  };
  const plan = buildAccountPriorityPlan({
    recentCallLimit: 500,
    accounts: [
      account(1, "https://codex-a.example plus 0.1", 90),
      grokAccount,
      { ...grokAccount, accountId: 11, accountName: "https://grok-b.example grok 0.05", score: 70, priority: 300,
        usage: { costRateCnyPerApiUsd: 0.05 } },
    ],
  }, config);
  expect(plan.profiles).toMatchObject({
    codex: { eligibleCount: 1 },
    grok: { eligibleCount: 2 },
  });
  expect((plan.changes as Array<Record<string, unknown>>).filter((row) => row.profile === "grok")).toHaveLength(2);
  expect(plan.priorities).toHaveProperty("10");
  expect(plan.priorities).toHaveProperty("11");
});
