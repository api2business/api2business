type Row = Record<string, unknown>;

function records(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((row): row is Row => typeof row === "object" && row !== null && !Array.isArray(row)) : [];
}

export function exhaustedQuotaWindows(usageResult: Row | null | undefined): string[] {
  if (!usageResult) return [];
  return records(usageResult.quotaWindows)
    .filter((window) => window.complete === true)
    .filter((window) => {
      const remainingPercent = Number(window.remainingPercent);
      return Number.isFinite(remainingPercent) && remainingPercent <= 0;
    })
    .map((window) => String(window.window ?? ""));
}

export function quotaWindowsExhausted(usageResult: Row | null | undefined): boolean {
  return exhaustedQuotaWindows(usageResult).length > 0;
}
