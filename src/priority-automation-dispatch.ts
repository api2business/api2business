export interface AutomationDispatchState {
  enabled: boolean;
  nextRunAt: Date | string | null;
  runId: string | null;
  runClaimedAt: Date | string | null;
  runStartedAt: Date | string | null;
}

function timestamp(value: Date | string | null): number | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function automationDispatchDelayMs(
  state: AutomationDispatchState | null,
  nowMs: number,
  runTimeoutMs: number,
  maximumSleepMs: number,
): { due: boolean; delayMs: number; reason: string } {
  if (!state || !state.enabled) {
    return { due: false, delayMs: maximumSleepMs, reason: "disabled" };
  }
  if (state.runId) {
    const activeAt = timestamp(state.runStartedAt) ?? timestamp(state.runClaimedAt) ?? nowMs;
    const recoveryAt = activeAt + runTimeoutMs;
    if (recoveryAt <= nowMs) return { due: true, delayMs: 0, reason: "expired-run" };
    return {
      due: false,
      delayMs: Math.max(1, Math.min(maximumSleepMs, recoveryAt - nowMs)),
      reason: "active-run",
    };
  }
  const nextRunAt = timestamp(state.nextRunAt);
  if (nextRunAt === null || nextRunAt <= nowMs) return { due: true, delayMs: 0, reason: "scheduled" };
  return {
    due: false,
    delayMs: Math.max(1, Math.min(maximumSleepMs, nextRunAt - nowMs)),
    reason: "waiting",
  };
}
