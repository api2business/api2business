export interface PriorityAutomationSafetyPolicy {
  maximumScoreQueryDurationMs: number;
  maximumChangedAccounts: number;
  maximumChangedFraction: number;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function priorityEntries(plan: Record<string, unknown>): Array<[string, number]> {
  return Object.entries(record(plan.priorities))
    .flatMap(([accountId, value]) => {
      const priority = finiteNumber(value);
      return priority === null ? [] : [[accountId, priority] as [string, number]];
    });
}

export function preparePriorityAutomationBatch(
  plan: Record<string, unknown>,
  policy: PriorityAutomationSafetyPolicy,
): Record<string, unknown> & { allowed: boolean } {
  const queryDurationMs = finiteNumber(plan.queryDurationMs);
  const eligibleCount = Math.max(0, finiteNumber(plan.eligibleCount) ?? 0);
  const entries = priorityEntries(plan);
  const fullChangedCount = entries.length;
  const changedFraction = eligibleCount > 0 ? fullChangedCount / eligibleCount : 0;
  const blockedReasons: string[] = [];
  const batchingReasons: string[] = [];

  if (queryDurationMs === null || queryDurationMs > policy.maximumScoreQueryDurationMs) {
    blockedReasons.push("score-query-slow-or-unknown");
  }
  if (fullChangedCount > policy.maximumChangedAccounts) {
    batchingReasons.push("changed-account-limit-exceeded");
  }
  if (changedFraction > policy.maximumChangedFraction) {
    batchingReasons.push("changed-fraction-limit-exceeded");
  }

  const changes = new Map(
    (Array.isArray(plan.changes) ? plan.changes : [])
      .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row))
      .map((row) => [String(row.accountId), row]),
  );
  entries.sort(([leftId, leftPriority], [rightId, rightPriority]) => {
    const leftBefore = finiteNumber(changes.get(leftId)?.beforePriority);
    const rightBefore = finiteNumber(changes.get(rightId)?.beforePriority);
    const leftRiskReduction = leftBefore !== null && leftPriority > leftBefore ? 0 : 1;
    const rightRiskReduction = rightBefore !== null && rightPriority > rightBefore ? 0 : 1;
    if (leftRiskReduction !== rightRiskReduction) return leftRiskReduction - rightRiskReduction;
    const leftDelta = leftBefore === null ? 0 : Math.abs(leftPriority - leftBefore);
    const rightDelta = rightBefore === null ? 0 : Math.abs(rightPriority - rightBefore);
    if (leftDelta !== rightDelta) return rightDelta - leftDelta;
    return Number(leftId) - Number(rightId);
  });

  const fractionLimit = eligibleCount > 0
    ? Math.max(1, Math.floor(eligibleCount * policy.maximumChangedFraction))
    : policy.maximumChangedAccounts;
  const batchLimit = Math.max(1, Math.min(policy.maximumChangedAccounts, fractionLimit));
  const selectedEntries = blockedReasons.length === 0 ? entries.slice(0, batchLimit) : [];
  const notSelectedEntries = entries.slice(selectedEntries.length);
  const selectedPriorities = Object.fromEntries(selectedEntries);
  const limited = blockedReasons.length === 0 && notSelectedEntries.length > 0;

  return {
    allowed: blockedReasons.length === 0,
    mode: blockedReasons.length > 0 ? "blocked" : limited ? "bounded" : "full",
    blockedReasons,
    batchingReasons,
    queryDurationMs,
    fullChangedCount,
    selectedChangedCount: selectedEntries.length,
    notSelectedChangedCount: notSelectedEntries.length,
    eligibleCount,
    changedFraction: Math.round(changedFraction * 1_000_000) / 1_000_000,
    selectedPriorities,
    policy,
  };
}
