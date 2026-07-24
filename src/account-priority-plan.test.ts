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
  expect(advice.statusAlerts[0]).toMatchObject({ accountId: 1, kind: "billing-depleted", procurementRelevant: true });
  expect(advice.recommendations[0]).toMatchObject({ supplier: "alpha.example", action: "renew-balance" });
  expect(advice.recommendations[0].currentlyAvailableAccountCount).toBe(0);
  expect(plan.priorities).not.toHaveProperty("1");
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
  expect(advice.statusAlerts[0]).toMatchObject({ accountId: 5, kind: "account-unavailable", procurementRelevant: false });
  expect(new Set(advice.recommendations.map((item: Record<string, unknown>) => item.supplier)).size).toBe(4);
  expect(advice.recommendations.find((item: Record<string, unknown>) => item.supplier === "alpha.example")).toMatchObject({
    historicalAccountCount: 2,
    qualifiedAccountCount: 2,
    currentlyAvailableAccountCount: 2,
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
  expect(advice.recommendations[0]).toMatchObject({ supplier: "alpha.example", action: "renew-balance" });
});
