function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decimal(value: unknown, places: number): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(places) : "-";
}

function printPart(name: string, value: unknown): void {
  const part = record(value) ?? {};
  const total = record(part.total) ?? {};
  console.log(`${name} accounts=${String(total.accountCount)} netCny=${decimal(total.netAcquisitionCostCny, 2)} apiUsd=${decimal(total.apiAmountUsd, 6)} remainingIdealApiUsd=${decimal(total.remainingIdealApiAmountUsd, 6)} cnyPerApiUsd=${decimal(total.cnyPerApiUsd, 6)} idealApiUsd=${decimal(total.idealApiAmountUsd, 6)} idealCnyPerApiUsd=${decimal(total.idealCnyPerApiUsd, 6)} requests=${String(total.requestCount)} tokens=${String(total.tokenCount)} complete=${String(total.complete)}`);
  const groups = Array.isArray(part.groups) ? part.groups : [];
  for (const item of groups) {
    const group = record(item) ?? {};
    console.log(`  PLAN type=${String(group.planType)} accounts=${String(group.accountCount)} normal=${String(group.normalCount ?? "-")} rateLimited=${String(group.rateLimitedCount ?? "-")} error=${String(group.errorCount ?? "-")} netCny=${decimal(group.netAcquisitionCostCny, 2)} avgUnitCny=${decimal(group.averageUnitCostCny, 6)} refundCny=${decimal(group.procurementRefundCny, 2)} apiUsd=${decimal(group.apiAmountUsd, 6)} remainingIdealApiUsd=${decimal(group.remainingIdealApiAmountUsd, 6)} cnyPerApiUsd=${decimal(group.cnyPerApiUsd, 6)} idealApiUsd=${decimal(group.idealApiAmountUsd, 6)} idealCnyPerApiUsd=${decimal(group.idealCnyPerApiUsd, 6)}`);
  }
}

export function emitOAuthEconomics(value: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  const health = record(value.health) ?? {};
  console.log(`APISTATE OAUTH POOL ECONOMICS complete=${String(value.complete)} usageScope=${String(value.usageScope)} databaseQueries=${String(value.databaseQueries)} queryDurationMs=${String(value.queryDurationMs)}`);
  const exclusions = record(value.exclusions) ?? {};
  console.log(`EXCLUSIONS count=${String(exclusions.count ?? 0)} accountIds=${Array.isArray(exclusions.accountIds) ? exclusions.accountIds.join(",") : ""}`);
  const warnings = Array.isArray(value.warnings) ? value.warnings : [];
  for (const item of warnings) {
    const warning = record(item) ?? {};
    console.log(`WARNING code=${String(warning.code)} missingData=${String(warning.missingData)} accountIds=${Array.isArray(warning.accountIds) ? warning.accountIds.join(",") : ""} planTypes=${Array.isArray(warning.planTypes) ? warning.planTypes.join(",") : ""} message=${String(warning.message)}`);
  }
  printPart("POOL", value.pool);
  printPart("ARCHIVED", value.archived);
  console.log(`HEALTH accounts=${String(health.accountCount)} normal=${String(health.normalCount)} rateLimited=${String(health.rateLimitedCount)} error=${String(health.errorCount)} active=${String(health.activeCount)} schedulable=${String(health.schedulableCount)} probeStarted=${String(health.probeStarted)}`);
  const all = record(record(value.all)?.total);
  if (all) console.log(`ALL netCny=${decimal(all.netAcquisitionCostCny, 2)} apiUsd=${decimal(all.apiAmountUsd, 6)} remainingIdealApiUsd=${decimal(all.remainingIdealApiAmountUsd, 6)} cnyPerApiUsd=${decimal(all.cnyPerApiUsd, 6)} idealApiUsd=${decimal(all.idealApiAmountUsd, 6)} idealCnyPerApiUsd=${decimal(all.idealCnyPerApiUsd, 6)}`);
}
