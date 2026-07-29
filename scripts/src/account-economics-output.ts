function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decimal(value: unknown, places: number): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(places) : "-";
}

export function emitAccountEconomics(value: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  const window = record(value.window) ?? {};
  console.log([
    `APISTATE ACCOUNT ECONOMICS complete=${String(value.complete)}`,
    `selected=${String(value.selectedAccountCount)}`,
    `matched=${String(value.matchedAccountCount)}`,
    `withUsage=${String(value.usageAccountCount)}`,
    `missing=${String(value.missingAccountCount)}`,
    `databaseQueries=${String(value.databaseQueries)}`,
    `queryDurationMs=${String(value.queryDurationMs)}`,
  ].join(" "));
  console.log(`WINDOW timezone=${String(window.timezone)} start=${String(window.startLocal)} end=${String(window.endLocal)} utcStart=${String(window.startUtc)} utcEnd=${String(window.endUtc)}`);
  console.log(`USAGE requests=${String(value.requestCount)} tokens=${String(value.tokenCount)} apiUsd=${decimal(value.apiAmountUsd, 6)} first=${String(value.firstUsedAt ?? "-")} last=${String(value.lastUsedAt ?? "-")}`);
  console.log(`COST acquisitionCny=${decimal(value.acquisitionCostCny, 2)} cnyPerApiUsd=${decimal(value.cnyPerApiUsd, 6)}`);
  if (Number(value.missingAccountCount) > 0) console.log(`MISSING accountIds=${Array.isArray(value.missingAccountIds) ? value.missingAccountIds.join(",") : "-"}`);
}
