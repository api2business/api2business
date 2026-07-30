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

export function emitAccountImportEconomics(value: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(`APISTATE IMPORT ECONOMICS complete=${String(value.complete)} day=${String(value.day)} databaseQueries=${String(value.databaseQueries)}`);
  const groups = Array.isArray(value.groups) ? value.groups : [];
  for (const item of groups) {
    const group = record(item) ?? {};
    console.log(`PLAN type=${String(group.planType)} accounts=${String(group.accountCount)} costCny=${decimal(group.acquisitionCostCny, 2)} apiUsd=${decimal(group.apiAmountUsd, 6)} cnyPerApiUsd=${decimal(group.cnyPerApiUsd, 6)} requests=${String(group.requestCount)} tokens=${String(group.tokenCount)}`);
  }
  const total = record(value.total) ?? {};
  console.log(`TOTAL accounts=${String(total.accountCount)} costCny=${decimal(total.acquisitionCostCny, 2)} apiUsd=${decimal(total.apiAmountUsd, 6)} cnyPerApiUsd=${decimal(total.cnyPerApiUsd, 6)} requests=${String(total.requestCount)} tokens=${String(total.tokenCount)}`);
}
