export function automationPollDelayMs(
  pollMs: number,
  maximumMs: number,
  consecutiveFailures: number,
  retryLimit = Number.MAX_SAFE_INTEGER,
  cooldownMs = maximumMs,
): number {
  if (!Number.isInteger(pollMs) || pollMs <= 0) throw new Error("pollMs must be a positive integer");
  if (!Number.isInteger(maximumMs) || maximumMs < pollMs) {
    throw new Error("maximumMs must be an integer greater than or equal to pollMs");
  }
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) {
    throw new Error("consecutiveFailures must be a non-negative integer");
  }
  if (!Number.isInteger(retryLimit) || retryLimit < 0) {
    throw new Error("retryLimit must be a non-negative integer");
  }
  if (!Number.isInteger(cooldownMs) || cooldownMs < maximumMs) {
    throw new Error("cooldownMs must be an integer greater than or equal to maximumMs");
  }
  if (consecutiveFailures === 0) return pollMs;
  // A failed cycle must not suppress future scheduled cycles. The database
  // lease already advances next_run_at; polling may back off briefly, but it
  // must keep observing the next due cycle instead of entering a long cooldown.
  if (consecutiveFailures > retryLimit) return maximumMs;
  return Math.min(maximumMs, pollMs * (2 ** Math.min(consecutiveFailures - 1, 30)));
}
