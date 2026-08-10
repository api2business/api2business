export interface ScoreScheduleFreshnessInput {
  nowMs: number;
  workerStartedAtMs: number;
  capturedAt: string | null;
  intervalMinutes: number;
  activityTimeoutMs?: number;
}

export interface ScoreScheduleFreshness {
  stale: boolean;
  ageMs: number;
  staleAfterMs: number;
  reference: "captured-snapshot" | "worker-start";
}

export function scoreScheduleFreshness(input: ScoreScheduleFreshnessInput): ScoreScheduleFreshness {
  const capturedAtMs = input.capturedAt === null ? Number.NaN : Date.parse(input.capturedAt);
  const hasSnapshot = Number.isFinite(capturedAtMs);
  const referenceMs = hasSnapshot ? capturedAtMs : input.workerStartedAtMs;
  const staleAfterMs = input.intervalMinutes * 3 * 60_000 + (input.activityTimeoutMs ?? 0);
  const ageMs = Math.max(0, input.nowMs - referenceMs);
  return {
    stale: ageMs > staleAfterMs,
    ageMs,
    staleAfterMs,
    reference: hasSnapshot ? "captured-snapshot" : "worker-start",
  };
}
