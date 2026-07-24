type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

export function emitErrorAggregate(value: Row, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(`APISTATE ERROR AGGREGATE limit=${String(value.limit)} requests=${String(value.distinctRequests)} visible=${String(value.customerVisibleRequests)} recovered=${String(value.recoveredRequests)} databaseQueries=${String(value.databaseQueries)} queryDurationMs=${String(value.queryDurationMs)}`);
  const dimensions = typeof value.dimensions === "object" && value.dimensions !== null
    ? value.dimensions as Row
    : {};
  for (const dimension of ["family", "status", "account", "phase", "model"]) {
    const items = rows(dimensions[dimension]);
    if (items.length === 0) continue;
    console.log(`\n${dimension.toUpperCase()}  VISIBLE  RECOVERED  REQUESTS  LABEL`);
    for (const item of items) {
      console.log([
        String(item.key ?? "-").padEnd(Math.max(8, dimension.length)),
        String(item.customerVisible ?? 0).padStart(7),
        String(item.recovered ?? 0).padStart(9),
        String(item.requests ?? 0).padStart(8),
        String(item.label ?? "-"),
      ].join("  "));
    }
  }
}
