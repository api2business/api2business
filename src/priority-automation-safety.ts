export interface PriorityAutomationSafetyPolicy {
  maximumScoreQueryDurationMs: number;
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

function orderedPriorityEntries(plan: Record<string, unknown>): Array<[string, number]> {
  const entries = priorityEntries(plan);
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
  return entries;
}

export function buildPriorityWriteBatches(
  plan: Record<string, unknown>,
  batchSize: number,
): Array<Record<string, number>> {
  const size = Math.max(1, Math.floor(batchSize));
  const entries = orderedPriorityEntries(plan);
  const batches: Array<Record<string, number>> = [];
  for (let index = 0; index < entries.length; index += size) {
    batches.push(Object.fromEntries(entries.slice(index, index + size)));
  }
  return batches;
}

export function buildPriorityWriteProfileQueues(
  plan: Record<string, unknown>,
  batchSize: number,
): Array<{ profile: string; batches: Array<Record<string, number>> }> {
  const size = Math.max(1, Math.floor(batchSize));
  const changes = new Map(
    (Array.isArray(plan.changes) ? plan.changes : [])
      .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row))
      .map((row) => [String(row.accountId), row]),
  );
  const profileEntries = new Map<string, Array<[string, number]>>();
  for (const entry of orderedPriorityEntries(plan)) {
    const profile = String(changes.get(entry[0])?.profile ?? "unknown");
    const entries = profileEntries.get(profile) ?? [];
    entries.push(entry);
    profileEntries.set(profile, entries);
  }
  return [...profileEntries].map(([profile, entries]) => {
    const batches: Array<Record<string, number>> = [];
    for (let index = 0; index < entries.length; index += size) {
      batches.push(Object.fromEntries(entries.slice(index, index + size)));
    }
    return { profile, batches };
  });
}

export function randomIntervalMs(minimumMs: number, maximumMs: number, random = Math.random): number {
  if (maximumMs <= minimumMs) return Math.max(0, Math.round(minimumMs));
  const sample = Math.max(0, Math.min(0.999999999, random()));
  return Math.round(minimumMs + sample * (maximumMs - minimumMs));
}

export function exponentialRetryDelayMs(
  initialDelayMs: number,
  retryNumber: number,
  jitterPercent: number,
  random = Math.random,
): number {
  const base = initialDelayMs * 2 ** Math.max(0, retryNumber - 1);
  const sample = Math.max(0, Math.min(0.999999999, random()));
  const jitterFactor = 1 - jitterPercent + sample * jitterPercent * 2;
  return Math.max(0, Math.round(base * jitterFactor));
}

export function preparePriorityAutomationBatch(
  plan: Record<string, unknown>,
  policy: PriorityAutomationSafetyPolicy,
  writeBatchSize: number,
): Record<string, unknown> & { allowed: boolean } {
  const queryDurationMs = finiteNumber(plan.queryDurationMs);
  const eligibleCount = Math.max(0, finiteNumber(plan.eligibleCount) ?? 0);
  const entries = orderedPriorityEntries(plan);
  const fullChangedCount = entries.length;
  const changedFraction = eligibleCount > 0 ? fullChangedCount / eligibleCount : 0;
  const blockedReasons: string[] = [];

  if (queryDurationMs === null || queryDurationMs > policy.maximumScoreQueryDurationMs) {
    blockedReasons.push("score-query-slow-or-unknown");
  }

  const selectedEntries = blockedReasons.length === 0 ? entries : [];
  const notSelectedEntries = entries.slice(selectedEntries.length);
  const selectedPriorities = Object.fromEntries(selectedEntries);
  const batchSize = Math.max(1, Math.floor(writeBatchSize));
  const writeBatchCount = selectedEntries.length === 0 ? 0 : Math.ceil(selectedEntries.length / batchSize);
  const paced = blockedReasons.length === 0 && writeBatchCount > 1;
  const batchingReasons = paced ? ["paced-write-required"] : [];

  return {
    allowed: blockedReasons.length === 0,
    mode: blockedReasons.length > 0 ? "blocked" : paced ? "paced" : "full",
    blockedReasons,
    batchingReasons,
    queryDurationMs,
    fullChangedCount,
    selectedChangedCount: selectedEntries.length,
    notSelectedChangedCount: notSelectedEntries.length,
    writeBatchSize: batchSize,
    writeBatchCount,
    eligibleCount,
    changedFraction: Math.round(changedFraction * 1_000_000) / 1_000_000,
    selectedPriorities,
    policy,
  };
}
