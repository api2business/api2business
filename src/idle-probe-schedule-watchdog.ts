export interface IdleProbeScheduleFreshnessInput {
  nowMs: number;
  workerStartedAtMs: number;
  lastAutomaticCompletedAt: string | null;
  intervalSeconds: number;
  roundTimeoutSeconds: number;
}

export interface IdleProbeScheduleFreshness {
  stale: boolean;
  ageMs: number;
  staleAfterMs: number;
  reference: "last-automatic-round" | "worker-start";
}

export function idleProbeScheduleFreshness(input: IdleProbeScheduleFreshnessInput): IdleProbeScheduleFreshness {
  const completedAtMs = input.lastAutomaticCompletedAt === null
    ? Number.NaN
    : Date.parse(input.lastAutomaticCompletedAt);
  const hasCompletedRound = Number.isFinite(completedAtMs);
  const referenceMs = hasCompletedRound ? completedAtMs : input.workerStartedAtMs;
  const staleAfterMs = (input.intervalSeconds * 3 + input.roundTimeoutSeconds) * 1000;
  const ageMs = Math.max(0, input.nowMs - referenceMs);
  return {
    stale: ageMs > staleAfterMs,
    ageMs,
    staleAfterMs,
    reference: hasCompletedRound ? "last-automatic-round" : "worker-start",
  };
}
