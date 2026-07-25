type Row = Record<string, unknown>;

function record(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {};
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function percent(value: unknown): string {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "-";
}

function milliseconds(value: unknown): string {
  return typeof value === "number" ? `${Math.round(value)}ms` : "-";
}

function decimal(value: unknown, digits = 1): string {
  return typeof value === "number" ? value.toFixed(digits) : "-";
}

export function renderPriorityPlanLines(value: Row): string[] {
  const lines = [
    `APISTATE PRIORITY PLAN calls=${String(value.recentCallLimit)} eligible=${String(value.eligibleCount)} changed=${String(value.changedCount)}`,
  ];
  const changes = rows(value.changes).filter((row) => row.change === "update");
  if (changes.length > 0) {
    lines.push("", "ACCOUNT_ID  BEFORE  AFTER     N  FAIL%  SWITCH%  TTFT_P95  QUALITY   COST  VALUE  ACCOUNT");
    for (const row of changes) lines.push([
      String(row.accountId ?? "-").padEnd(10),
      String(row.beforePriority ?? "-").padStart(6),
      String(row.desiredPriority ?? "-").padStart(5),
      String(row.observedAttempts ?? "-").padStart(5),
      percent(row.failureRate).padStart(6),
      percent(row.failoverRate).padStart(7),
      milliseconds(row.ttftP95Ms).padStart(9),
      decimal(row.score).padStart(7),
      decimal(row.costRateCnyPerApiUsd, 3).padStart(6),
      decimal(row.combinedScore).padStart(5),
      String(row.accountName ?? "-"),
    ].join("  "));
  }
  const advice = record(value.procurementAdvice);
  const summary = record(advice.summary);
  lines.push("", `PROCUREMENT redundancy=${String(summary.redundancyStatus ?? "disabled")} suppliers=${String(summary.stableSupplierCount ?? 0)} largestShare=${typeof summary.largestSupplierShare === "number" ? `${(summary.largestSupplierShare * 100).toFixed(1)}%` : "-"} unavailable=${String(summary.unavailableAccountCount ?? 0)} billing=${String(summary.billingDepletedAccountCount ?? 0)}`);
  const alertLimit = Number(record(record(value.policy).procurementAdvice).statusAlertLimit ?? 0);
  const alerts = rows(advice.statusAlerts).slice(0, alertLimit);
  if (alerts.length > 0) {
    lines.push("", "KIND                 SCORE  CHANNELS  AVAILABLE  BILLING_SITE");
    for (const row of alerts) lines.push([
      String(row.kind ?? "-").padEnd(20),
      String(row.qualityScore ?? "-").padStart(5),
      String(row.channelCount ?? "-").padStart(8),
      String(row.availableChannelCount ?? "-").padStart(9),
      String(row.billingSite ?? "unknown"),
    ].join("  "));
  }
  const recommendations = rows(advice.recommendations);
  if (recommendations.length > 0) {
    lines.push("", "ACTION                    QUALITY  VALUE  REDUNDANCY  SCORE  SUPPLIER");
    for (const row of recommendations) lines.push([
      String(row.action ?? "-").padEnd(24),
      String(row.qualityScore ?? "-").padStart(7),
      String(row.valueScore ?? "-").padStart(5),
      String(row.redundancyScore ?? "-").padStart(10),
      String(row.procurementScore ?? "-").padStart(5),
      String(row.billingSite ?? "-"),
    ].join("  "));
  }
  const priorities = record(value.priorities);
  const sortedPriorities = Object.fromEntries(
    Object.entries(priorities).sort(([left], [right]) => Number(left) - Number(right)),
  );
  lines.push("", `PRIORITIES_JSON ${JSON.stringify(sortedPriorities)}`);
  lines.push(`APPLY ${JSON.stringify(value.apply)}`);
  return lines;
}

export function emitPriorityPlan(value: Row, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(renderPriorityPlanLines(value).join("\n"));
}
