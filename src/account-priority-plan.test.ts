import { expect, test } from "bun:test";
import { buildAccountPriorityPlan } from "./account-priority-plan";
import type { AppConfig } from "./config";

const config = {
  monitor: {
    target: "example-runtime",
  },
  operations: {
    priorityWrite: {
      batchSize: 3,
    },
  },
  sub2api: {
    priorityPlan: {
      platform: "openai",
      eligibleGroupIds: [2, 3],
      requiredConfidence: "high",
      requireCurrentAvailable: true,
      qualityWeight: 80,
      costWeight: 20,
      explorationWeight: 0,
      explorationTargetAttempts: 50,
      explorationQualityPrior: 0,
      balanceWeight: 0,
      dynamicQualityFeedback: { targetQualityScore: 85, coefficient: 0 },
      referenceScore: 92,
      pointsPerScore: 10,
      minimumChange: 5,
      normalizationTopK: 20,
      minimumPriorityUniformity: 0.25,
      minimumPriority: 100,
      maximumPriority: 300,
      fixedPriorities: {},
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
      explorationWeight: 0,
      explorationTargetAttempts: 50,
      explorationQualityPrior: 0,
      balanceWeight: 0,
      dynamicQualityFeedback: { targetQualityScore: 85, coefficient: 0 },
      referenceScore: 80,
      pointsPerScore: 8,
      minimumChange: 5,
      normalizationTopK: 20,
      minimumPriorityUniformity: 0.25,
      minimumPriority: 100,
      maximumPriority: 300,
      fixedPriorities: {},
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

test("priority plan reports billing depletion and moves unavailable accounts to the top-k tail", () => {
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    account(1, "https://alpha.example pro 0.1", 95, false, "403 Insufficient account balance"),
    account(2, "https://beta.example pro 0.1", 90),
  ] }, config);
  const advice = plan.procurementAdvice as Record<string, any>;
  expect(advice.statusAlerts[0]).toMatchObject({ billingSite: "alpha.example", kind: "billing-depleted", procurementRelevant: true });
  expect(advice.statusAlerts[0]).not.toHaveProperty("accountId");
  expect(advice.recommendations[0]).toMatchObject({ billingSite: "alpha.example", action: "renew-balance" });
  expect(advice.recommendations[0].availableChannelCount).toBe(0);
  expect(plan.priorities).toMatchObject({ "1": 300 });
});

test("OAuth accounts are excluded from scoring-derived priority changes", () => {
  const oauth = account(3, "https://oauth.example plus 0.1", 99);
  (oauth as Record<string, unknown>).accountType = "oauth";
  oauth.priority = 1;
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    account(1, "https://alpha.example plus 0.1", 90),
    oauth,
  ] }, config);

  expect(plan.eligibleCount).toBe(1);
  expect(plan.changes).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ accountId: 3 }),
  ]));
  expect(plan.priorities).not.toHaveProperty("3");
});

test("Codex economic ranking keeps the highest-cost quality leader below better-value accounts", () => {
  const weightedConfig = structuredClone(config);
  weightedConfig.sub2api.priorityPlan.qualityWeight = 70;
  weightedConfig.sub2api.priorityPlan.costWeight = 30;
  const economicAccount = (id: number, name: string, score: number, cost: number) => ({
    ...account(id, name, score),
    usage: { costRateCnyPerApiUsd: cost },
  });
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    economicAccount(1, "https://expensive.example pro 0.18", 82.9, 0.18),
    economicAccount(2, "https://balanced-a.example pro 0.08", 69.1, 0.08),
    economicAccount(3, "https://balanced-b.example plus 0.05", 60.4, 0.05),
    economicAccount(4, "https://economy.example plus 0.04", 45.9, 0.04),
    economicAccount(5, "https://balanced-c.example plus 0.08", 54.3, 0.08),
  ] }, weightedConfig);
  const ranked = (plan.changes as Array<Record<string, unknown>>)
    .filter((row) => row.priorityMode !== "topk-tail")
    .sort((left, right) => Number(left.rank) - Number(right.rank));
  expect(ranked.map((row) => row.accountId)).toEqual([3, 2, 4, 5, 1]);
  expect(ranked.at(-1)).toMatchObject({ accountId: 1, rank: 5, costRateCnyPerApiUsd: 0.18 });
});

test("reserve policy dynamically lowers priority as weekly quota is depleted", () => {
  const reserveConfig = structuredClone(config);
  reserveConfig.sub2api.priorityPlan.reservePolicies = {
    "2": { lowRemainingThresholdPercent: 20, unrestrictedRemainingThresholdPercent: 50, lowRemainingPriority: 600 },
  };
  const reserveAccount: Record<string, unknown> = account(2, "stable reserve pro 0.1", 99);
  reserveAccount.weeklyRemainingPercent = 19;
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    account(1, "https://alpha.example plus 0.05", 90),
    reserveAccount,
  ] }, reserveConfig);
  const reserve = (plan.changes as Array<Record<string, unknown>>).find((row) => row.accountId === 2);
  expect(reserve).toMatchObject({
    configuredPriorityFloor: 300,
    priorityFloorApplied: true,
    desiredPriority: 300,
    reservePolicy: {
      weeklyRemainingPercent: 19,
      lowRemainingThresholdPercent: 20,
      unrestrictedRemainingThresholdPercent: 50,
      reserveWeight: 1,
      mode: "low-remaining-reserve",
    },
  });
  expect(plan.priorities).toMatchObject({ "2": 300 });
});

test("fixed priority account is excluded from dynamic optimization and only corrected to its declared value", () => {
  const fixedConfig = structuredClone(config);
  fixedConfig.sub2api.priorityPlan.fixedPriorities = { "2": 1 };
  const fixedAccount: Record<string, unknown> = account(2, "lyon9801 0", 99);
  fixedAccount.priority = 101;
  fixedAccount.weeklyRemainingPercent = 5;
  fixedAccount.usage = { costRateCnyPerApiUsd: 0 };
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    account(1, "https://alpha.example plus 0.1", 90),
    fixedAccount,
  ] }, fixedConfig);
  const fixed = (plan.changes as Array<Record<string, unknown>>).find((row) => row.accountId === 2);
  expect(plan.eligibleCount).toBe(1);
  expect(plan.fixedCount).toBe(1);
  expect(plan.costRange).toEqual({ minimumCostRateCnyPerApiUsd: 0.1, maximumCostRateCnyPerApiUsd: 0.1 });
  expect(fixed).toMatchObject({
    beforePriority: 101,
    desiredPriority: 1,
    priorityMode: "fixed",
    reservePolicy: null,
    change: "update",
  });
  expect(plan.priorities).toMatchObject({ "2": 1 });

  fixedAccount.priority = 1;
  const converged = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    account(1, "https://alpha.example plus 0.1", 90),
    fixedAccount,
  ] }, fixedConfig);
  const convergedFixed = (converged.changes as Array<Record<string, unknown>>).find((row) => row.accountId === 2);
  expect(convergedFixed).toMatchObject({ desiredPriority: 1, priorityMode: "fixed", change: "noop" });
  expect(converged.priorities).not.toHaveProperty("2");
});

test("reserve policy is unrestricted above half quota and weighted below it", () => {
  const reserveConfig = structuredClone(config);
  reserveConfig.sub2api.priorityPlan.minimumChange = 1;
  reserveConfig.sub2api.priorityPlan.reservePolicies = {
    "2": { lowRemainingThresholdPercent: 20, unrestrictedRemainingThresholdPercent: 50, lowRemainingPriority: 600 },
  };
  const fullAccount: Record<string, unknown> = account(2, "stable reserve pro 0.1", 99);
  fullAccount.weeklyRemainingPercent = 100;
  const fullPlan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    account(1, "https://alpha.example plus 0.05", 90),
    fullAccount,
  ] }, reserveConfig);
  const full = (fullPlan.changes as Array<Record<string, unknown>>).find((row) => row.accountId === 2);
  expect(full).toMatchObject({
    configuredPriorityFloor: null,
    priorityFloorApplied: false,
    reservePolicy: {
      weeklyRemainingPercent: 100,
      reserveWeight: 0,
      mode: "unrestricted-cost-aware",
    },
  });

  const weightedAccount: Record<string, unknown> = account(2, "stable reserve pro 0.1", 99);
  weightedAccount.weeklyRemainingPercent = 35;
  const weightedPlan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    account(1, "https://alpha.example plus 0.05", 90),
    weightedAccount,
  ] }, reserveConfig);
  const weighted = (weightedPlan.changes as Array<Record<string, unknown>>).find((row) => row.accountId === 2)!;
  const calculated = weighted.calculatedPriority as number;
  expect(weighted).toMatchObject({
    configuredPriorityFloor: 300,
    priorityFloorApplied: true,
    reservePolicy: {
      weeklyRemainingPercent: 35,
      reserveWeight: 0.5,
      mode: "weighted-reserve",
    },
  });
});

test("stable ranking inserts a moved leader between unchanged local anchors", () => {
  const leader = account(1, "https://leader.example plus 0.1", 95);
  leader.priority = 110;
  const peer = account(2, "https://peer.example plus 0.1", 85);
  peer.priority = 120;
  const tail = account(3, "https://tail.example plus 0.1", 75);
  tail.priority = 130;
  const healthyPlan = buildAccountPriorityPlan({
    recentCallLimit: 1000,
    queryDurationMs: 800,
    accounts: [leader, peer, tail],
  }, config);

  const degradedLeader = { ...leader, score: 80 };
  const degradedPlan = buildAccountPriorityPlan({
    recentCallLimit: 1000,
    queryDurationMs: 900,
    accounts: [degradedLeader, peer, tail],
  }, config);
  const changedIds = (degradedPlan.changes as Array<Record<string, unknown>>)
    .filter((row) => row.change === "update")
    .map((row) => row.accountId);

  expect(healthyPlan.anchorScore).toBe(92);
  expect(degradedPlan.anchorScore).toBe(92);
  expect(healthyPlan.observedAnchorScore).not.toBe(degradedPlan.observedAnchorScore);
  expect(healthyPlan.priorities).toEqual({});
  expect(changedIds).toEqual([1]);
  expect(degradedPlan.priorities).toEqual({ "1": 125 });
  expect((degradedPlan.changes as Array<Record<string, unknown>>).map((row) => [row.accountId, row.desiredPriority])).toEqual([
    [2, 120],
    [1, 125],
    [3, 130],
  ]);
});

test("rank normalization uses the full band and keeps OAuth outside it untouched", () => {
  const fullBandConfig = structuredClone(config);
  fullBandConfig.sub2api.priorityPlan.normalizationTopK = 3;
  const oauth = account(9, "oauth fallback", 100);
  (oauth as Record<string, unknown>).accountType = "oauth";
  oauth.priority = 350;
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [
    account(1, "best", 99),
    account(2, "middle", 80),
    account(3, "worst", 60),
    oauth,
  ] }, fullBandConfig);
  const dynamic = (plan.changes as Array<Record<string, unknown>>)
    .filter((row) => row.priorityMode === "stable-rank" || row.priorityMode === "normalized-rebalance");

  expect(dynamic.map((row) => [row.accountId, row.rank, row.normalizedPriority])).toEqual([
    [1, 1, 100],
    [2, 2, 200],
    [3, 3, 300],
  ]);
  expect(plan.priorities).not.toHaveProperty("9");
});

test("minimum change suppresses small pool-wide drift after an account is added", () => {
  const stableConfig = structuredClone(config);
  stableConfig.sub2api.priorityPlan.normalizationTopK = 21;
  const existing = Array.from({ length: 21 }, (_, index) => {
    const row = account(index + 1, `account-${index + 1}`, 100 - index);
    row.priority = 100 + index * 10;
    return row;
  });
  const added = account(22, "new-tail", 0);
  added.priority = 1;
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [...existing, added] }, stableConfig);
  const changedIds = (plan.changes as Array<Record<string, unknown>>)
    .filter((row) => row.change === "update")
    .map((row) => row.accountId);

  expect(changedIds).toEqual([22]);
  expect(plan.priorities).toMatchObject({ "22": 300 });
});

test("accounts beyond top-k converge to the lower scheduling boundary", () => {
  const rows = Array.from({ length: 22 }, (_, index) => {
    const row = account(index + 1, `account-${index + 1}`, 100 - index);
    row.priority = index < 20 ? 100 + Math.round(index * 200 / 19) : 150;
    return row;
  });
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: rows }, config);
  const changes = plan.changes as Array<Record<string, unknown>>;

  expect(changes.find((row) => row.accountId === 20)).toMatchObject({ rank: 20, calculatedPriority: 300 });
  expect(changes.find((row) => row.accountId === 21)).toMatchObject({ rank: 21, calculatedPriority: 300, desiredPriority: 300 });
  expect(changes.find((row) => row.accountId === 22)).toMatchObject({ rank: 22, calculatedPriority: 300, desiredPriority: 300 });
});

test("available low-confidence accounts receive weighted exploration while unavailable accounts stay at the tail", () => {
  const lowConfidence = account(31, "low-confidence", 80);
  lowConfidence.priority = 800;
  lowConfidence.confidence = "low";
  const unavailable = account(32, "unavailable", 70);
  unavailable.priority = 80;
  unavailable.currentAvailable = false;
  const oauth = account(33, "oauth-fallback", 60);
  oauth.priority = 900;
  (oauth as Record<string, unknown>).accountType = "oauth";

  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [lowConfidence, unavailable, oauth] }, config);
  const changes = plan.changes as Array<Record<string, unknown>>;

  expect(plan.priorities).toHaveProperty("32", 300);
  expect(plan.priorities).not.toHaveProperty("33");
  expect(changes.find((row) => row.accountId === 31)).toMatchObject({ priorityMode: "stable-rank", rank: 1 });
  expect(changes.find((row) => row.accountId === 32)).toMatchObject({ priorityMode: "topk-tail", desiredPriority: 300 });
});

test("small samples use a decaying exploration weight and enter the top exploration band", () => {
  const explorationConfig = structuredClone(config);
  explorationConfig.sub2api.priorityPlan.qualityWeight = 25;
  explorationConfig.sub2api.priorityPlan.costWeight = 20;
  explorationConfig.sub2api.priorityPlan.explorationWeight = 30;
  explorationConfig.sub2api.priorityPlan.explorationTargetAttempts = 50;
  explorationConfig.sub2api.priorityPlan.explorationQualityPrior = 25;
  explorationConfig.sub2api.priorityPlan.balanceWeight = 25;
  const matureScores = [92, 86, 78, 70, 62, 54].map((score, index) => account(index + 1, `mature-${index + 1}`, score));
  [38, 24, 22, 18, 5, 0].forEach((balance, index) => { matureScores[index]!.accountBalanceCny = balance; });
  const newcomer = account(20, "newcomer", 24);
  newcomer.accountBalanceCny = 20;
  newcomer.confidence = "low";
  newcomer.observedAttempts = 1;
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [...matureScores, newcomer] }, explorationConfig);
  const change = (plan.changes as Array<Record<string, unknown>>).find((row) => row.accountId === 20)!;

  expect(change.rank).toBeGreaterThanOrEqual(1);
  expect(change.rank).toBeLessThanOrEqual(5);
  expect(Number(change.explorationScore)).toBeGreaterThan(95);
});

test("a schedulable zero-sample account enters exploration before it has a quality score", () => {
  const explorationConfig = structuredClone(config);
  explorationConfig.sub2api.priorityPlan.qualityWeight = 25;
  explorationConfig.sub2api.priorityPlan.costWeight = 20;
  explorationConfig.sub2api.priorityPlan.explorationWeight = 30;
  explorationConfig.sub2api.priorityPlan.explorationTargetAttempts = 50;
  explorationConfig.sub2api.priorityPlan.explorationQualityPrior = 25;
  explorationConfig.sub2api.priorityPlan.balanceWeight = 25;
  const matureScores = [92, 86, 78, 70, 62, 54].map((score, index) => account(index + 1, `mature-${index + 1}`, score));
  [38, 24, 22, 18, 5, 0].forEach((balance, index) => { matureScores[index]!.accountBalanceCny = balance; });
  const newcomer = account(20, "zero-sample", 0);
  newcomer.accountBalanceCny = 20;
  newcomer.score = null;
  newcomer.confidence = "low";
  newcomer.observedAttempts = 0;
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: [...matureScores, newcomer] }, explorationConfig);
  const change = (plan.changes as Array<Record<string, unknown>>).find((row) => row.accountId === 20)!;

  expect(change.priorityMode).not.toBe("topk-tail");
  expect(change.rank).toBeGreaterThanOrEqual(1);
  expect(change.rank).toBeLessThanOrEqual(5);
  expect(change.explorationScore).toBe(100);
});

test("stable ranking remains distributed and ordered through repeated local moves", () => {
  const rows = Array.from({ length: 24 }, (_, index) => {
    const row = account(index + 1, `account-${index + 1}`, 100 - index);
    row.priority = index < 20 ? 100 + Math.round(index * 200 / 19) : 300;
    return row;
  });
  let maximumChangedCount = 0;
  let fullRebalanceCount = 0;
  for (let iteration = 0; iteration < 400; iteration += 1) {
    const rankedRows = [...rows].sort((left, right) => right.score - left.score);
    const position = iteration % 19;
    const firstScore = rankedRows[position].score;
    rankedRows[position].score = rankedRows[position + 1].score;
    rankedRows[position + 1].score = firstScore;
    const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: rows }, config);
    const dynamic = (plan.changes as Array<Record<string, unknown>>)
      .filter((row) => row.priorityMode === "stable-rank" || row.priorityMode === "normalized-rebalance");
    const top = dynamic.slice(0, 20);
    const priorities = top.map((row) => row.desiredPriority as number);
    const changed = dynamic.filter((row) => row.change === "update");
    maximumChangedCount = Math.max(maximumChangedCount, changed.length);
    if (dynamic.some((row) => row.priorityMode === "normalized-rebalance")) fullRebalanceCount += 1;

    expect(priorities.every((priority, index) => index === 0 || priority > priorities[index - 1])).toBeTrue();
    expect(priorities[0]).toBeGreaterThanOrEqual(100);
    expect(priorities[19]).toBeLessThanOrEqual(300);
    expect(priorities[19] - priorities[0]).toBeGreaterThanOrEqual(120);
    expect(dynamic.slice(20).every((row) => row.desiredPriority === 300)).toBeTrue();
    for (const change of changed) {
      rows.find((row) => row.accountId === change.accountId)!.priority = change.desiredPriority as number;
    }
  }

  expect(maximumChangedCount).toBeLessThanOrEqual(20);
  expect(fullRebalanceCount).toBeGreaterThan(0);
  expect(fullRebalanceCount).toBeLessThan(80);
});

test("a uniformly clustered top-k is globally rebalanced across the configured band", () => {
  const rows = Array.from({ length: 20 }, (_, index) => {
    const row = account(index + 1, `clustered-${index + 1}`, 100 - index);
    row.priority = 180 + index;
    return row;
  });
  const plan = buildAccountPriorityPlan({ recentCallLimit: 1000, accounts: rows }, config);
  const dynamic = plan.changes as Array<Record<string, unknown>>;

  expect(dynamic.every((row) => row.priorityMode === "normalized-rebalance")).toBeTrue();
  expect(dynamic[0]).toMatchObject({ desiredPriority: 100, priorityRebalanced: true });
  expect(dynamic[19]).toMatchObject({ desiredPriority: 300, priorityRebalanced: true });
  expect(dynamic[0].priorityUniformity).toBe(1);
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
  expect(plan.priorities).toEqual({ "1": 300 });
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
  expect(plan.priorities).toEqual({ "1": 300, "2": 300 });
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
  expect(plan.priorities).not.toHaveProperty("10");
  expect(plan.priorities).not.toHaveProperty("11");
});

test("dynamic pool-quality feedback is positive below target and negative above target", () => {
  const feedbackConfig = structuredClone(config);
  feedbackConfig.sub2api.priorityPlan.dynamicQualityFeedback = {
    targetQualityScore: 85,
    coefficient: 2,
  };
  const rows = [account(1, "quality-leader 0.08", 90), account(2, "quality-follower 0.08", 60)];
  const below = buildAccountPriorityPlan({ recentCallLimit: 1000, poolQualityScore: 75, accounts: rows }, feedbackConfig);
  const above = buildAccountPriorityPlan({ recentCallLimit: 1000, poolQualityScore: 95, accounts: rows }, feedbackConfig);
  const belowLeader = (below.changes as Array<Record<string, unknown>>).find((row) => row.accountId === 1)!;
  const aboveLeader = (above.changes as Array<Record<string, unknown>>).find((row) => row.accountId === 1)!;

  expect(Number(belowLeader.dynamicQualityExtraScore)).toBeCloseTo(18);
  expect(Number(aboveLeader.dynamicQualityExtraScore)).toBeCloseTo(-18);
  expect(Number(belowLeader.combinedScore)).toBeGreaterThan(Number(belowLeader.baseCombinedScore));
  expect(Number(aboveLeader.combinedScore)).toBeLessThan(Number(aboveLeader.baseCombinedScore));
});
