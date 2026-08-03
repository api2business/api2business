export function remainingScheduleDelayMs(intervalMs: number, elapsedMs: number): number {
  return Math.max(0, intervalMs - Math.max(0, elapsedMs));
}
