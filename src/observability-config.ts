export interface ObservabilityConfig {
  sub2apiSuccessPercent: number;
  sub2apiTtftP95Ms: number;
  api2businessNon5xxPercent: number;
  api2businessLatencyP95Ms: number;
  walletFreshnessSeconds: number;
  retentionDays: number;
}

export function parseObservabilityConfig(input: unknown): ObservabilityConfig | null {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("observability must be an object");
  const row = input as Record<string, unknown>;
  const limits = {
    sub2apiSuccessPercent: [0, 100], sub2apiTtftP95Ms: [1, 300000],
    api2businessNon5xxPercent: [0, 100], api2businessLatencyP95Ms: [1, 300000],
    walletFreshnessSeconds: [1, 604800], retentionDays: [1, 365],
  };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const value = row[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min! || value > max!) {
      throw new Error(`observability.${key} must be between ${min} and ${max}`);
    }
  }
  return Object.fromEntries(Object.keys(limits).map(key => [key, row[key]])) as unknown as ObservabilityConfig;
}
