function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function emitUserImpact(value: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  const users = Array.isArray(value.users)
    ? value.users.map(record).filter((row): row is Record<string, unknown> => row !== null)
    : [];
  const window = record(value.window) ?? {};
  console.log([
    `API2BUSINESS USER IMPACT mode=${String(value.mode)}`,
    `users=${String(value.userCount)}`,
    `active=${String(value.activeUserCount)}`,
    `affected=${String(value.affectedUserCount)}`,
    `databaseQueries=${String(value.databaseQueries)}`,
    `queryDurationMs=${String(value.queryDurationMs)}`,
  ].join(" "));
  console.log(`WINDOW timezone=${String(window.timezone)} start=${String(window.startLocal)} end=${String(window.endLocal)} utcStart=${String(window.startUtc)} utcEnd=${String(window.endUtc)}`);
  console.log("AFFECTED  USER_ID  NAME       EMAIL                 SUCCESS  INFRA_FAIL  FAIL%   COST_USD  TOKENS      FIRST_ACTIVE               LAST_ACTIVE");
  for (const row of users) {
    const failureRate = typeof row.failureRate === "number"
      ? `${(row.failureRate * 100).toFixed(2)}%`
      : "-";
    console.log([
      (row.affected === true ? "yes" : "no").padEnd(8),
      String(row.userId ?? "-").padStart(7),
      String(row.displayNameMasked ?? "-").padEnd(10),
      String(row.emailMasked ?? "-").padEnd(21),
      String(row.successRequests ?? 0).padStart(7),
      String(row.customerVisibleInfrastructureFailures ?? 0).padStart(10),
      failureRate.padStart(7),
      Number(row.actualCostUsd ?? 0).toFixed(4).padStart(8),
      String(row.tokens ?? 0).padStart(10),
      String(row.firstActiveAt ?? "-").padEnd(26),
      String(row.lastActiveAt ?? "-"),
    ].join("  "));
  }
}
