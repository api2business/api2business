import type { AppConfig } from "./config";

type ScoreRow = Record<string, unknown>;

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildAccountPriorityPlan(
  ranking: Record<string, unknown>,
  config: AppConfig,
): Record<string, unknown> {
  const policy = config.sub2api.priorityPlan;
  if (policy.maximumPriority < policy.minimumPriority) {
    throw new Error("sub2api.priorityPlan.maximumPriority must be >= minimumPriority");
  }
  const rows = Array.isArray(ranking.accounts)
    ? ranking.accounts.filter((row): row is ScoreRow => typeof row === "object" && row !== null && !Array.isArray(row))
    : [];
  const eligible = rows.filter((row) => {
    const groups = Array.isArray(row.groupIds) ? row.groupIds : [];
    return row.platform === policy.platform
      && row.confidence === policy.requiredConfidence
      && (!policy.requireCurrentAvailable || row.currentAvailable === true)
      && groups.some((id) => typeof id === "number" && policy.eligibleGroupIds.includes(id))
      && number(row.score) !== null;
  });
  const anchorScore = eligible.reduce((best, row) => Math.max(best, number(row.score)!), -Infinity);
  const priorities: Record<string, number> = {};
  const changes = eligible.map((row) => {
    const accountId = number(row.accountId);
    const score = number(row.score)!;
    const before = number(row.priority);
    if (accountId === null || before === null) throw new Error("eligible score row is missing accountId or priority");
    const calculated = Math.min(
      policy.maximumPriority,
      Math.max(policy.minimumPriority, policy.minimumPriority + Math.round((anchorScore - score) * policy.pointsPerScore)),
    );
    const desired = Math.abs(before - calculated) < policy.minimumChange ? before : calculated;
    if (before !== desired) priorities[String(accountId)] = desired;
    return {
      accountId,
      accountName: row.accountName,
      score,
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
  return {
    ok: true,
    action: "scores-priority-plan",
    mutation: false,
    recentCallLimit: ranking.recentCallLimit,
    policy,
    anchorScore,
    eligibleCount: eligible.length,
    changedCount: Object.keys(priorities).length,
    priorities,
    changes,
    apply: {
      command: "bun scripts/cli.ts platform-infra sub2api codex-pool runtime apply --target PK01 --kind priority --priorities-json '<priorities>' --confirm",
      oneBatch: true,
    },
  };
}
