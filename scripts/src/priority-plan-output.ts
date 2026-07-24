type Row = Record<string, unknown>;

function record(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {};
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

export function emitPriorityPlan(value: Row, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(`APISTATE PRIORITY PLAN calls=${String(value.recentCallLimit)} eligible=${String(value.eligibleCount)} changed=${String(value.changedCount)}`);
  const changes = rows(value.changes).filter((row) => row.change === "update");
  if (changes.length > 0) {
    console.log("\nACCOUNT_ID  BEFORE  AFTER  SCORE  VALUE  ACCOUNT");
    for (const row of changes) console.log([
      String(row.accountId ?? "-").padEnd(8),
      String(row.beforePriority ?? "-").padStart(6),
      String(row.desiredPriority ?? "-").padStart(5),
      String(row.score ?? "-").padStart(5),
      typeof row.combinedScore === "number" ? row.combinedScore.toFixed(1).padStart(5) : "    -",
      String(row.accountName ?? "-"),
    ].join("  "));
  }
  const advice = record(value.procurementAdvice);
  const summary = record(advice.summary);
  console.log(`\nPROCUREMENT redundancy=${String(summary.redundancyStatus ?? "disabled")} suppliers=${String(summary.stableSupplierCount ?? 0)} largestShare=${typeof summary.largestSupplierShare === "number" ? `${(summary.largestSupplierShare * 100).toFixed(1)}%` : "-"} unavailable=${String(summary.unavailableAccountCount ?? 0)} billing=${String(summary.billingDepletedAccountCount ?? 0)}`);
  const alertLimit = Number(record(record(value.policy).procurementAdvice).statusAlertLimit ?? 0);
  const alerts = rows(advice.statusAlerts).slice(0, alertLimit);
  if (alerts.length > 0) {
    console.log("\nACCOUNT_ID     KIND                 SCORE  SUPPLIER  ACCOUNT");
    for (const row of alerts) console.log([
      String(row.accountId ?? "-").padEnd(13),
      String(row.kind ?? "-").padEnd(20),
      String(row.qualityScore ?? "-").padStart(5),
      String(row.supplier ?? "unknown"),
      String(row.accountName ?? "-"),
    ].join("  "));
  }
  const recommendations = rows(advice.recommendations);
  if (recommendations.length > 0) {
    console.log("\nACTION                    QUALITY  VALUE  REDUNDANCY  SCORE  SUPPLIER");
    for (const row of recommendations) console.log([
      String(row.action ?? "-").padEnd(24),
      String(row.qualityScore ?? "-").padStart(7),
      String(row.valueScore ?? "-").padStart(5),
      String(row.redundancyScore ?? "-").padStart(10),
      String(row.procurementScore ?? "-").padStart(5),
      String(row.supplier ?? "-"),
    ].join("  "));
  }
  console.log(`\nAPPLY ${JSON.stringify(value.apply)}`);
}
