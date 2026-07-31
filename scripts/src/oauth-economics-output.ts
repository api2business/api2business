function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decimal(value: unknown, places: number): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(places) : "-";
}

function expectedAmount(value: Record<string, unknown>): unknown {
  return value.expectedApiAmountUsd ?? value.idealApiAmountUsd;
}

function expectedRemaining(value: Record<string, unknown>): unknown {
  return value.remainingExpectedApiAmountUsd ?? value.remainingIdealApiAmountUsd;
}

function expectedUnitCost(value: Record<string, unknown>): unknown {
  return value.expectedCnyPerApiUsd ?? value.idealCnyPerApiUsd;
}

function printPart(name: string, value: unknown): void {
  const part = record(value) ?? {};
  const total = record(part.total) ?? {};
  console.log(`${name} accounts=${String(total.accountCount)} netCny=${decimal(total.netAcquisitionCostCny, 2)} apiUsd=${decimal(total.apiAmountUsd, 6)} unavailableApiUsd=${decimal(total.unavailableApiAmountUsd, 6)} remainingExpectedApiUsd=${decimal(expectedRemaining(total), 6)} cnyPerApiUsd=${decimal(total.cnyPerApiUsd, 6)} expectedApiUsd=${decimal(expectedAmount(total), 6)} expectedCnyPerApiUsd=${decimal(expectedUnitCost(total), 6)} expectedOutputBasis=${String(total.expectedOutputBasis ?? "configured")} complete=${String(total.complete)}`);
  const groups = Array.isArray(part.groups) ? part.groups : [];
  for (const item of groups) {
    const group = record(item) ?? {};
    console.log(`  PLAN type=${String(group.planType)} accounts=${String(group.accountCount)} normal=${String(group.normalCount ?? "-")} rateLimited=${String(group.rateLimitedCount ?? "-")} error=${String(group.errorCount ?? "-")} netCny=${decimal(group.netAcquisitionCostCny, 2)} avgUnitCny=${decimal(group.averageUnitCostCny, 6)} refundCny=${decimal(group.procurementRefundCny, 2)} apiUsd=${decimal(group.apiAmountUsd, 6)} unavailableApiUsd=${decimal(group.unavailableApiAmountUsd, 6)} remainingExpectedApiUsd=${decimal(expectedRemaining(group), 6)} cnyPerApiUsd=${decimal(group.cnyPerApiUsd, 6)} expectedApiUsd=${decimal(expectedAmount(group), 6)} expectedCnyPerApiUsd=${decimal(expectedUnitCost(group), 6)} expectedOutputBasis=${String(group.expectedOutputBasis ?? "configured")}`);
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
  if (all) console.log(`ALL netCny=${decimal(all.netAcquisitionCostCny, 2)} apiUsd=${decimal(all.apiAmountUsd, 6)} unavailableApiUsd=${decimal(all.unavailableApiAmountUsd, 6)} remainingExpectedApiUsd=${decimal(expectedRemaining(all), 6)} cnyPerApiUsd=${decimal(all.cnyPerApiUsd, 6)} expectedApiUsd=${decimal(expectedAmount(all), 6)} expectedCnyPerApiUsd=${decimal(expectedUnitCost(all), 6)} expectedOutputBasis=${String(all.expectedOutputBasis ?? "configured")}`);
}
