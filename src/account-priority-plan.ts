import type { AppConfig } from "./config";
import type { PriorityPlanPolicy } from "./config";
import { buildProcurementAdvice } from "./account-procurement-advice";
import { isOAuthAccount } from "./account-score-eligibility";

type ScoreRow = Record<string, unknown>;

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rankingMeasurement(ranking: Record<string, unknown>): Record<string, unknown> {
  return {
    databaseQueries: number(ranking.databaseQueries),
    queryDurationMs: number(ranking.queryDurationMs),
    totalDurationMs: number(ranking.totalDurationMs),
    collectionStartedAt: ranking.collectionStartedAt ?? null,
    queryStartedAt: ranking.queryStartedAt ?? null,
    queryCompletedAt: ranking.queryCompletedAt ?? null,
    collectedAt: ranking.collectedAt ?? null,
  };
}

function costRate(row: ScoreRow): number | null {
  const detected = number(row.detectedCostRateCnyPerApiUsd);
  if (detected !== null && detected > 0) return detected;
  if (typeof row.usage !== "object" || row.usage === null || Array.isArray(row.usage)) return null;
  return number((row.usage as ScoreRow).costRateCnyPerApiUsd);
}

function buildStableRankPriorities(
  ranked: Array<{ row: ScoreRow; combinedScore: number }>,
  policy: PriorityPlanPolicy,
): { priorities: number[]; rebalanced: boolean; uniformity: number } {
  const topCount = Math.min(ranked.length, policy.normalizationTopK);
  const prioritySpan = policy.maximumPriority - policy.minimumPriority;
  const normalized = ranked.map((_, index) => {
    const normalizedRank = Math.min(index + 1, policy.normalizationTopK);
    return policy.minimumPriority
      + Math.round((normalizedRank - 1) * prioritySpan / (policy.normalizationTopK - 1));
  });
  if (topCount === 0) return { priorities: normalized, rebalanced: false, uniformity: 1 };

  const candidates = ranked.slice(0, topCount).map(({ row }, index) => {
    const priority = number(row.priority);
    const minimumAtIndex = policy.minimumPriority + index;
    const maximumAtIndex = policy.maximumPriority - (topCount - index - 1);
    return priority !== null && priority >= minimumAtIndex && priority <= maximumAtIndex
      ? priority
      : null;
  });
  const lengths: number[] = candidates.map((priority) => priority === null ? 0 : 1);
  const sums: number[] = candidates.map((priority) => priority ?? 0);
  const previous = candidates.map(() => -1);
  for (let index = 0; index < candidates.length; index += 1) {
    if (candidates[index] === null) continue;
    for (let prior = 0; prior < index; prior += 1) {
      if (candidates[prior] === null
        || candidates[index]! - candidates[prior]! < index - prior) continue;
      const candidateLength = lengths[prior] + 1;
      const candidateSum = sums[prior] + candidates[index]!;
      if (candidateLength > lengths[index]
        || (candidateLength === lengths[index] && candidateSum > sums[index])) {
        lengths[index] = candidateLength;
        sums[index] = candidateSum;
        previous[index] = prior;
      }
    }
  }
  let anchorEnd = -1;
  for (let index = 0; index < candidates.length; index += 1) {
    if (anchorEnd === -1 || lengths[index] > lengths[anchorEnd]
      || (lengths[index] === lengths[anchorEnd] && sums[index] > sums[anchorEnd])) {
      anchorEnd = index;
    }
  }
  if (anchorEnd === -1 || lengths[anchorEnd] === 0) {
    return { priorities: normalized, rebalanced: false, uniformity: 1 };
  }

  const anchors: number[] = [];
  for (let index = anchorEnd; index >= 0; index = previous[index]) {
    anchors.push(index);
    if (previous[index] === -1) break;
  }
  anchors.reverse();
  const stable = [...normalized];
  const boundaries = [-1, ...anchors, topCount];
  for (const anchor of anchors) stable[anchor] = candidates[anchor]!;
  for (let boundary = 0; boundary < boundaries.length - 1; boundary += 1) {
    const leftIndex = boundaries[boundary];
    const rightIndex = boundaries[boundary + 1];
    const leftPriority = leftIndex === -1 ? policy.minimumPriority - 1 : stable[leftIndex];
    const rightPriority = rightIndex === topCount ? policy.maximumPriority + 1 : stable[rightIndex];
    const gap = rightIndex - leftIndex - 1;
    for (let offset = 1; offset <= gap; offset += 1) {
      stable[leftIndex + offset] = leftPriority
        + Math.round(offset * (rightPriority - leftPriority) / (gap + 1));
    }
  }
  const top = stable.slice(0, topCount);
  const strictlyOrdered = top.every((priority, index) => index === 0 || priority > top[index - 1]);
  const expectedSpan = normalized[topCount - 1] - normalized[0];
  const stableSpan = top[topCount - 1] - top[0];
  const gaps = top.slice(1).map((priority, index) => priority - top[index]);
  const uniformity = gaps.length === 0 ? 1 : Math.min(...gaps) / Math.max(...gaps);
  const normalizedStep = Math.ceil(prioritySpan / (policy.normalizationTopK - 1));
  const distributionGuardEnabled = topCount >= Math.ceil(policy.normalizationTopK / 2);
  const distributionDrifted = distributionGuardEnabled && (
    top[0] > policy.minimumPriority + 2 * normalizedStep
      || top[topCount - 1] < normalized[topCount - 1] - 2 * normalizedStep
      || stableSpan < Math.max(topCount - 1, Math.round(expectedSpan * 0.6))
      || uniformity < policy.minimumPriorityUniformity
  );
  if (!strictlyOrdered || distributionDrifted) {
    return { priorities: normalized, rebalanced: true, uniformity };
  }
  return { priorities: stable, rebalanced: false, uniformity };
}

function buildPriorityProfile(
  ranking: Record<string, unknown>,
  config: AppConfig,
  profile: "codex" | "grok",
  policy: PriorityPlanPolicy,
): Record<string, unknown> {
  if (policy.maximumPriority < policy.minimumPriority) {
    throw new Error("sub2api.priorityPlan.maximumPriority must be >= minimumPriority");
  }
  const totalWeight = policy.qualityWeight + policy.costWeight + policy.explorationWeight + policy.balanceWeight;
  if (totalWeight <= 0) {
    throw new Error("sub2api.priorityPlan qualityWeight + costWeight + explorationWeight + balanceWeight must be positive");
  }
  const rows = Array.isArray(ranking.accounts)
    ? ranking.accounts.filter((row): row is ScoreRow => typeof row === "object" && row !== null && !Array.isArray(row))
    : [];
  const profileRow = (row: ScoreRow): boolean => {
    const groups = Array.isArray(row.groupIds) ? row.groupIds : [];
    return !isOAuthAccount(row)
      && row.platform === policy.platform
      && groups.some((id) => typeof id === "number" && policy.eligibleGroupIds.includes(id));
  };
  const fixedAccountIds = new Set(Object.keys(policy.fixedPriorities));
  const fixedChanges = rows.flatMap((row) => {
    const accountId = number(row.accountId);
    if (accountId === null || !profileRow(row) || !fixedAccountIds.has(String(accountId))) return [];
    const before = number(row.priority);
    if (before === null) throw new Error("fixed priority row is missing priority");
    const desired = policy.fixedPriorities[String(accountId)];
    return [{
      profile,
      accountId,
      accountName: row.accountName,
      score: number(row.score),
      costRateCnyPerApiUsd: costRate(row),
      confidence: row.confidence,
      observedAttempts: row.observedAttempts,
      failureRate: row.failureRate,
      failoverRate: row.failoverRate,
      ttftP95Ms: row.ttftP95Ms,
      beforePriority: before,
      calculatedPriority: null,
      configuredPriorityFloor: null,
      priorityFloorApplied: false,
      reservePolicy: null,
      priorityMode: "fixed",
      desiredPriority: desired,
      change: before === desired ? "noop" : "update",
    }];
  });
  const priorities: Record<string, number> = Object.fromEntries(
    fixedChanges
      .filter((row) => row.change === "update")
      .map((row) => [String(row.accountId), row.desiredPriority]),
  );
  const eligible = rows.filter((row) => {
    const accountId = number(row.accountId);
    const attempts = Math.max(0, number(row.observedAttempts) ?? 0);
    const hasExplorationEvidence = policy.explorationWeight > 0
      && attempts < policy.explorationTargetAttempts;
    return profileRow(row)
      && accountId !== null
      && !fixedAccountIds.has(String(accountId))
      && (!policy.requireCurrentAvailable || row.currentAvailable === true)
      && (number(row.score) !== null || hasExplorationEvidence)
      && costRate(row) !== null;
  });
  const costs = eligible.map((row) => costRate(row)!);
  const fallbackCosts = rows.flatMap((row) => {
    const accountId = number(row.accountId);
    const cost = costRate(row);
    return profileRow(row)
      && accountId !== null
      && !fixedAccountIds.has(String(accountId))
      && row.confidence === policy.requiredConfidence
      && cost !== null
      ? [cost]
      : [];
  });
  const costEvidence = costs.length > 0 ? costs : fallbackCosts;
  if (costEvidence.length === 0) {
    return {
      ok: true,
      action: "scores-priority-plan",
      mutation: false,
      recentCallLimit: ranking.recentCallLimit,
      profile,
      policy,
      ...rankingMeasurement(ranking),
      anchorScore: null,
      observedAnchorScore: null,
      priorityReferenceScore: policy.referenceScore,
      costRange: null,
      eligibleCount: 0,
      fixedCount: fixedChanges.length,
      changedCount: Object.keys(priorities).length,
      priorities,
      changes: fixedChanges,
      procurementAdvice: profile === "codex"
        ? buildProcurementAdvice(rows.filter((row) => !isOAuthAccount(row)), config, { minimum: 0, maximum: 0 })
        : { enabled: false, statusAlerts: [], recommendations: [] },
    };
  }
  const minimumCost = Math.min(...costEvidence);
  const maximumCost = Math.max(...costEvidence);
  const knownBalances = eligible.map((row) => number(row.accountBalanceCny)).filter((value): value is number => value !== null);
  const minimumBalance = knownBalances.length ? Math.min(...knownBalances) : null;
  const maximumBalance = knownBalances.length ? Math.max(...knownBalances) : null;
  const balanceScore = (row: ScoreRow): number => {
    const balance = number(row.accountBalanceCny);
    if (balance === null || minimumBalance === null || maximumBalance === null) return 50;
    return maximumBalance === minimumBalance ? 100 : 100 * (balance - minimumBalance) / (maximumBalance - minimumBalance);
  };
  const baseEconomicScore = (row: ScoreRow): number => {
    const quality = number(row.score) ?? policy.explorationQualityPrior;
    const cost = costRate(row)!;
    const costScore = maximumCost === minimumCost ? 100 : 100 * (maximumCost - cost) / (maximumCost - minimumCost);
    const attempts = Math.max(0, number(row.observedAttempts) ?? 0);
    const explorationScore = 100 * Math.max(0, 1 - attempts / policy.explorationTargetAttempts);
    return (quality * policy.qualityWeight
      + costScore * policy.costWeight
      + explorationScore * policy.explorationWeight
      + balanceScore(row) * policy.balanceWeight) / totalWeight;
  };
  const currentPoolQualityScore = number(ranking.poolQualityScore);
  const dynamicQualityExtraScore = (row: ScoreRow): number => {
    if (currentPoolQualityScore === null || policy.dynamicQualityFeedback.coefficient === 0) return 0;
    const quality = number(row.score) ?? policy.explorationQualityPrior;
    return (policy.dynamicQualityFeedback.targetQualityScore - currentPoolQualityScore)
      * policy.dynamicQualityFeedback.coefficient * quality / 100;
  };
  const economicScore = (row: ScoreRow): number => Math.max(0, Math.min(100,
    baseEconomicScore(row) + dynamicQualityExtraScore(row),
  ));
  const observedAnchorScore = eligible.length === 0
    ? null
    : eligible.reduce((best, row) => Math.max(best, economicScore(row)), -Infinity);
  const priorityReferenceScore = policy.referenceScore;
  const ranked = eligible
    .map((row) => ({ row, combinedScore: economicScore(row) }))
    .sort((left, right) => {
      const scoreDifference = right.combinedScore - left.combinedScore;
      if (scoreDifference !== 0) return scoreDifference;
      return number(left.row.accountId)! - number(right.row.accountId)!;
    });
  const stablePriorityPlan = buildStableRankPriorities(ranked, policy);
  let previousScore: number | null = null;
  let previousRank = 0;
  const dynamicChanges = ranked.map(({ row, combinedScore }, index) => {
    const accountId = number(row.accountId);
    const score = number(row.score);
    const cost = costRate(row)!;
    const costScore = maximumCost === minimumCost ? 100 : 100 * (maximumCost - cost) / (maximumCost - minimumCost);
    const attempts = Math.max(0, number(row.observedAttempts) ?? 0);
    const explorationScore = 100 * Math.max(0, 1 - attempts / policy.explorationTargetAttempts);
    const weightedBalanceScore = balanceScore(row);
    const before = number(row.priority);
    if (accountId === null || before === null) throw new Error("eligible score row is missing accountId or priority");
    const rank = previousScore === combinedScore ? previousRank : index + 1;
    previousScore = combinedScore;
    previousRank = rank;
    const normalizedRank = Math.min(rank, policy.normalizationTopK);
    const normalizedPriority = policy.minimumPriority
      + Math.round((normalizedRank - 1) * (policy.maximumPriority - policy.minimumPriority)
        / (policy.normalizationTopK - 1));
    const calculated = stablePriorityPlan.priorities[index];
    const reservePolicy = policy.reservePolicies[String(accountId)] ?? null;
    const remainingPercent = number(row.weeklyRemainingPercent);
    const lowRemaining = reservePolicy !== null
      && (remainingPercent === null || remainingPercent < reservePolicy.lowRemainingThresholdPercent);
    const unrestricted = reservePolicy !== null
      && remainingPercent !== null
      && remainingPercent > reservePolicy.unrestrictedRemainingThresholdPercent;
    const reserveWeight = reservePolicy === null || unrestricted
      ? 0
      : lowRemaining
        ? 1
        : (reservePolicy.unrestrictedRemainingThresholdPercent - remainingPercent!)
          / (reservePolicy.unrestrictedRemainingThresholdPercent - reservePolicy.lowRemainingThresholdPercent);
    const weightedFloor = reservePolicy === null || unrestricted
      ? null
      : Math.round(calculated + reserveWeight * (reservePolicy.lowRemainingPriority - calculated));
    const configuredFloor = weightedFloor === null
      ? null
      : Math.min(policy.maximumPriority, Math.max(calculated, weightedFloor));
    const bounded = configuredFloor === null ? calculated : configuredFloor;
    const desired = bounded;
    if (before !== desired) priorities[String(accountId)] = desired;
    return {
      profile,
      accountId,
      accountName: row.accountName,
      score,
      costRateCnyPerApiUsd: cost,
      costScore,
      explorationScore,
      balanceScore: weightedBalanceScore,
      baseCombinedScore: baseEconomicScore(row),
      dynamicQualityExtraScore: dynamicQualityExtraScore(row),
      currentPoolQualityScore,
      targetPoolQualityScore: policy.dynamicQualityFeedback.targetQualityScore,
      qualityFeedbackCoefficient: policy.dynamicQualityFeedback.coefficient,
      accountBalanceCny: number(row.accountBalanceCny),
      costSource: number(row.detectedCostRateCnyPerApiUsd) !== null ? "detected" : "manual",
      combinedScore,
      rank,
      rankCount: ranked.length,
      normalizationTopK: policy.normalizationTopK,
      priorityUniformity: stablePriorityPlan.uniformity,
      priorityRebalanced: stablePriorityPlan.rebalanced,
      confidence: row.confidence,
      observedAttempts: row.observedAttempts,
      failureRate: row.failureRate,
      failoverRate: row.failoverRate,
      ttftP95Ms: row.ttftP95Ms,
      beforePriority: before,
      calculatedPriority: calculated,
      normalizedPriority,
      configuredPriorityFloor: configuredFloor,
      priorityFloorApplied: configuredFloor !== null && bounded !== calculated,
      reservePolicy: reservePolicy === null ? null : {
        weeklyRemainingPercent: remainingPercent,
        lowRemainingThresholdPercent: reservePolicy.lowRemainingThresholdPercent,
        unrestrictedRemainingThresholdPercent: reservePolicy.unrestrictedRemainingThresholdPercent,
        reserveWeight,
        mode: unrestricted ? "unrestricted-cost-aware" : lowRemaining ? "low-remaining-reserve" : "weighted-reserve",
      },
      desiredPriority: desired,
      priorityMode: stablePriorityPlan.rebalanced ? "normalized-rebalance" : "stable-rank",
      change: before === desired ? "noop" : "update",
    };
  });
  const rankedAccountIds = new Set(ranked.map(({ row }) => number(row.accountId)));
  const tailChanges = rows.flatMap((row) => {
    const accountId = number(row.accountId);
    if (accountId === null
      || !profileRow(row)
      || fixedAccountIds.has(String(accountId))
      || rankedAccountIds.has(accountId)) return [];
    const before = number(row.priority);
    if (before === null) return [];
    const desired = policy.maximumPriority;
    if (before !== desired) priorities[String(accountId)] = desired;
    return [{
      profile,
      accountId,
      accountName: row.accountName,
      score: number(row.score),
      costRateCnyPerApiUsd: costRate(row),
      confidence: row.confidence,
      observedAttempts: row.observedAttempts,
      failureRate: row.failureRate,
      failoverRate: row.failoverRate,
      ttftP95Ms: row.ttftP95Ms,
      beforePriority: before,
      calculatedPriority: desired,
      normalizedPriority: desired,
      configuredPriorityFloor: null,
      priorityFloorApplied: false,
      reservePolicy: null,
      desiredPriority: desired,
      priorityMode: "topk-tail",
      change: before === desired ? "noop" : "update",
    }];
  });
  const procurementAdvice = profile === "codex"
    ? buildProcurementAdvice(rows.filter((row) => !isOAuthAccount(row)), config, { minimum: minimumCost, maximum: maximumCost })
    : { enabled: false, statusAlerts: [], recommendations: [] };
  return {
    ok: true,
    action: "scores-priority-plan",
    mutation: false,
    recentCallLimit: ranking.recentCallLimit,
    profile,
    policy,
    ...rankingMeasurement(ranking),
    anchorScore: eligible.length === 0 ? null : priorityReferenceScore,
    observedAnchorScore,
    currentPoolQualityScore,
    priorityReferenceScore,
    costRange: { minimumCostRateCnyPerApiUsd: minimumCost, maximumCostRateCnyPerApiUsd: maximumCost },
    eligibleCount: eligible.length,
    fixedCount: fixedChanges.length,
    changedCount: Object.keys(priorities).length,
    priorities,
    changes: [...fixedChanges, ...dynamicChanges, ...tailChanges],
    procurementAdvice,
    apply: {
      through: "api2business-priority-plan-confirm",
      target: config.monitor.target,
      writeMode: "backend-api-paced",
      batchSize: config.operations.priorityWrite.batchSize,
      verification: "native-api-read-broker",
    },
  };
}

export function buildAccountPriorityPlan(
  ranking: Record<string, unknown>,
  config: AppConfig,
): Record<string, unknown> {
  const codex = buildPriorityProfile(ranking, config, "codex", config.sub2api.priorityPlan);
  const grok = buildPriorityProfile(ranking, config, "grok", config.sub2api.grokPriorityPlan);
  const priorities = {
    ...(codex.priorities as Record<string, number>),
    ...(grok.priorities as Record<string, number>),
  };
  const changes = [
    ...(codex.changes as Array<Record<string, unknown>>),
    ...(grok.changes as Array<Record<string, unknown>>),
  ];
  return {
    ...codex,
    policy: { codex: config.sub2api.priorityPlan, grok: config.sub2api.grokPriorityPlan },
    profiles: {
      codex: {
        eligibleCount: codex.eligibleCount,
        fixedCount: codex.fixedCount,
        changedCount: codex.changedCount,
        anchorScore: codex.anchorScore,
        observedAnchorScore: codex.observedAnchorScore,
        priorityReferenceScore: codex.priorityReferenceScore,
        costRange: codex.costRange,
      },
      grok: {
        eligibleCount: grok.eligibleCount,
        fixedCount: grok.fixedCount,
        changedCount: grok.changedCount,
        anchorScore: grok.anchorScore,
        observedAnchorScore: grok.observedAnchorScore,
        priorityReferenceScore: grok.priorityReferenceScore,
        costRange: grok.costRange,
      },
    },
    eligibleCount: Number(codex.eligibleCount) + Number(grok.eligibleCount),
    changedCount: Object.keys(priorities).length,
    priorities,
    changes,
  };
}
