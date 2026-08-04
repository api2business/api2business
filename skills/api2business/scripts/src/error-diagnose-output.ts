type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => typeof item === "object" && item !== null)
    : [];
}

export function emitErrorDiagnosis(value: Row, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  const summary = typeof value.summary === "object" && value.summary !== null
    ? value.summary as Row
    : {};
  console.log(
    `API2BUSINESS ERROR DIAGNOSIS rows=${String(summary.sampledErrorRows ?? 0)}`
    + ` requests=${String(summary.distinctRequests ?? 0)}`
    + ` visible=${String(summary.customerVisibleRequests ?? 0)}`
    + ` recovered=${String(summary.recoveredRequests ?? 0)}`
    + ` failover=${String(summary.failoverTriggeredRequests ?? 0)}`
    + ` failoverRecovered=${String(summary.failoverRecoveredRequests ?? 0)}`
    + ` failoverFailed=${String(summary.failoverFailedRequests ?? 0)}`
    + ` databaseQueries=${String(value.databaseQueries ?? 0)}`,
  );
  console.log("VISIBLE  REQUESTS  RECOVERED  ACCOUNTS  SIGNATURE");
  for (const row of rows(value.signatures)) {
    console.log([
      String(row.customerVisible ?? 0).padStart(7),
      String(row.requests ?? 0).padStart(8),
      String(row.recovered ?? 0).padStart(9),
      String(row.accounts ?? 0).padStart(8),
      String(row.signature ?? "-"),
    ].join("  "));
  }
  const chains = rows(value.chains);
  if (chains.length === 0) return;
  console.log("\nCUSTOMER-VISIBLE / FAILOVER SAMPLES");
  console.log("VISIBLE  RECOVERED  FAILOVER  ATTEMPTS  STATUS  REQUEST_ID  FINAL_SIGNATURE");
  for (const row of chains) {
    console.log([
      (row.customerVisible === true ? "yes" : "no").padEnd(7),
      (row.recovered === true ? "yes" : "no").padEnd(9),
      (row.failoverTriggered === true ? "yes" : "no").padEnd(8),
      String(row.attemptCount ?? 0).padStart(8),
      String(row.finalStatusCode ?? "-").padStart(6),
      String(row.requestId ?? "-").padEnd(36),
      String(row.finalSignature ?? "-"),
    ].join("  "));
  }
}
