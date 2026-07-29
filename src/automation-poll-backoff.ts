export function automationPollDelayMs(
  pollMs: number,
  maximumMs: number,
  consecutiveFailures: number,
): number {
  if (!Number.isInteger(pollMs) || pollMs <= 0) throw new Error("pollMs must be a positive integer");
  if (!Number.isInteger(maximumMs) || maximumMs < pollMs) {
    throw new Error("maximumMs must be an integer greater than or equal to pollMs");
  }
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) {
    throw new Error("consecutiveFailures must be a non-negative integer");
  }
  if (consecutiveFailures === 0) return pollMs;
  return Math.min(maximumMs, pollMs * (2 ** Math.min(consecutiveFailures - 1, 30)));
}
