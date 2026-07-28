export function jitteredIntervalSeconds(
  intervalSeconds: number,
  jitterPercent: number,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) throw new Error("intervalSeconds must be positive");
  if (!Number.isFinite(jitterPercent) || jitterPercent < 0 || jitterPercent > 0.5) {
    throw new Error("jitterPercent must be between 0 and 0.5");
  }
  const factor = 1 + (random() * 2 - 1) * jitterPercent;
  return Math.max(1, Math.round(intervalSeconds * factor));
}
