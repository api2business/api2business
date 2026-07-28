import type { AppConfig } from "./config";
import type { PriorityPlanPolicy } from "./config";
import { buildProcurementAdvice } from "./account-procurement-advice";

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
  if (typeof row.usage !== "object" || row.usage === null || Array.isArray(row.usage)) return null;
  return number((row.usage as ScoreRow).costRateCnyPerApiUsd);
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
  const totalWeight = policy.qualityWeight + policy.costWeight;
  if (totalWeight <= 0) throw new Error("sub2api.priorityPlan qualityWeight + costWeight must be positive");
  const rows = Array.isArray(ranking.accounts)
    ? ranking.accounts.filter((row): row is ScoreRow => typeof row === "object" && row !== null && !Array.isArray(row))
    : [];
  const eligible = rows.filter((row) => {
    const groups = Array.isArray(row.groupIds) ? row.groupIds : [];
    return row.platform === policy.platform
      && row.confidence === policy.requiredConfidence
      && (!policy.requireCurrentAvailable || row.currentAvailable === true)
      && groups.some((id) => typeof id === "number" && policy.eligibleGroupIds.includes(id))
      && number(row.score) !== null
      && costRate(row) !== null;
  });
  const costs = eligible.map((row) => costRate(row)!);
  const fallbackCosts = rows.flatMap((row) => {
    const groups = Array.isArray(row.groupIds) ? row.groupIds : [];
    const cost = costRate(row);
    return row.platform === policy.platform
      && row.confidence === policy.requiredConfidence
      && groups.some((id) => typeof id === "number" && policy.eligibleGroupIds.includes(id))
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
      changedCount: 0,
      priorities: {},
      changes: [],
      procurementAdvice: profile === "codex"
        ? buildProcurementAdvice(rows, config, { minimum: 0, maximum: 0 })
        : { enabled: false, statusAlerts: [], recommendations: [] },
    };
  }
  const minimumCost = Math.min(...costEvidence);
  const maximumCost = Math.max(...costEvidence);
  const economicScore = (row: ScoreRow): number => {
    const quality = number(row.score)!;
    const cost = costRate(row)!;
    const costScore = maximumCost === minimumCost ? 100 : 100 * (maximumCost - cost) / (maximumCost - minimumCost);
    return (quality * policy.qualityWeight + costScore * policy.costWeight) / totalWeight;
  };
  const observedAnchorScore = eligible.length === 0
    ? null
    : eligible.reduce((best, row) => Math.max(best, economicScore(row)), -Infinity);
  const priorityReferenceScore = policy.referenceScore;
  const priorities: Record<string, number> = {};
  const changes = eligible.map((row) => {
    const accountId = number(row.accountId);
    const score = number(row.score)!;
    const cost = costRate(row)!;
    const costScore = maximumCost === minimumCost ? 100 : 100 * (maximumCost - cost) / (maximumCost - minimumCost);
    const combinedScore = economicScore(row);
    const before = number(row.priority);
    if (accountId === null || before === null) throw new Error("eligible score row is missing accountId or priority");
    const calculated = Math.min(
      policy.maximumPriority,
      Math.max(
        policy.minimumPriority,
        policy.minimumPriority + Math.round((priorityReferenceScore - combinedScore) * policy.pointsPerScore),
      ),
    );
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
    const configuredFloor = weightedFloor === null ? null : Math.max(calculated, weightedFloor);
    const floored = configuredFloor === null ? calculated : Math.max(calculated, configuredFloor);
    const desired = Math.abs(before - floored) < policy.minimumChange ? before : floored;
    if (before !== desired) priorities[String(accountId)] = desired;
    return {
      profile,
      accountId,
      accountName: row.accountName,
      score,
      costRateCnyPerApiUsd: cost,
      costScore,
      combinedScore,
      confidence: row.confidence,
      observedAttempts: row.observedAttempts,
      failureRate: row.failureRate,
      failoverRate: row.failoverRate,
      ttftP95Ms: row.ttftP95Ms,
      beforePriority: before,
      calculatedPriority: calculated,
      configuredPriorityFloor: configuredFloor,
      priorityFloorApplied: configuredFloor !== null && floored !== calculated,
      reservePolicy: reservePolicy === null ? null : {
        weeklyRemainingPercent: remainingPercent,
        lowRemainingThresholdPercent: reservePolicy.lowRemainingThresholdPercent,
        unrestrictedRemainingThresholdPercent: reservePolicy.unrestrictedRemainingThresholdPercent,
        reserveWeight,
        mode: unrestricted ? "unrestricted-cost-aware" : lowRemaining ? "low-remaining-reserve" : "weighted-reserve",
      },
      desiredPriority: desired,
      change: before === desired ? "noop" : "update",
    };
  });
  const procurementAdvice = profile === "codex"
    ? buildProcurementAdvice(rows, config, { minimum: minimumCost, maximum: maximumCost })
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
    priorityReferenceScore,
    costRange: { minimumCostRateCnyPerApiUsd: minimumCost, maximumCostRateCnyPerApiUsd: maximumCost },
    eligibleCount: eligible.length,
    changedCount: Object.keys(priorities).length,
    priorities,
    changes,
    procurementAdvice,
    apply: {
      command: "bun scripts/cli.ts platform-infra sub2api codex-pool runtime apply --target PK01 --kind priority --priorities-json '<priorities>' --write-only --confirm",
      oneBatch: true,
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
        changedCount: codex.changedCount,
        anchorScore: codex.anchorScore,
        observedAnchorScore: codex.observedAnchorScore,
        priorityReferenceScore: codex.priorityReferenceScore,
        costRange: codex.costRange,
      },
      grok: {
        eligibleCount: grok.eligibleCount,
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
