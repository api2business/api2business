import type { AppConfig } from "./config";
import { buildProcurementAdvice } from "./account-procurement-advice";

type ScoreRow = Record<string, unknown>;

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function costRate(row: ScoreRow): number | null {
  if (typeof row.usage !== "object" || row.usage === null || Array.isArray(row.usage)) return null;
  return number((row.usage as ScoreRow).costRateCnyPerApiUsd);
}

export function buildAccountPriorityPlan(
  ranking: Record<string, unknown>,
  config: AppConfig,
): Record<string, unknown> {
  const policy = config.sub2api.priorityPlan;
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
  if (costEvidence.length === 0) throw new Error("priority plan has no accounts with known cost");
  const minimumCost = Math.min(...costEvidence);
  const maximumCost = Math.max(...costEvidence);
  const economicScore = (row: ScoreRow): number => {
    const quality = number(row.score)!;
    const cost = costRate(row)!;
    const costScore = maximumCost === minimumCost ? 100 : 100 * (maximumCost - cost) / (maximumCost - minimumCost);
    return (quality * policy.qualityWeight + costScore * policy.costWeight) / totalWeight;
  };
  const anchorScore = eligible.length === 0
    ? null
    : eligible.reduce((best, row) => Math.max(best, economicScore(row)), -Infinity);
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
      Math.max(policy.minimumPriority, policy.minimumPriority + Math.round((anchorScore! - combinedScore) * policy.pointsPerScore)),
    );
    const desired = Math.abs(before - calculated) < policy.minimumChange ? before : calculated;
    if (before !== desired) priorities[String(accountId)] = desired;
    return {
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
      desiredPriority: desired,
      change: before === desired ? "noop" : "update",
    };
  });
  const procurementAdvice = buildProcurementAdvice(rows, config, { minimum: minimumCost, maximum: maximumCost });
  return {
    ok: true,
    action: "scores-priority-plan",
    mutation: false,
    recentCallLimit: ranking.recentCallLimit,
    policy,
    anchorScore,
    costRange: { minimumCostRateCnyPerApiUsd: minimumCost, maximumCostRateCnyPerApiUsd: maximumCost },
    eligibleCount: eligible.length,
    changedCount: Object.keys(priorities).length,
    priorities,
    changes,
    procurementAdvice,
    apply: {
      command: "bun scripts/cli.ts platform-infra sub2api codex-pool runtime apply --target PK01 --kind priority --priorities-json '<priorities>' --confirm",
      oneBatch: true,
    },
  };
}
