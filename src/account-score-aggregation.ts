import { isOAuthAccount } from "./account-score-eligibility";

type Row = Record<string, unknown>;

function accountKey(row: Row): string {
  if (row.accountId !== null && row.accountId !== undefined) return `id:${String(row.accountId)}`;
  return `name:${String(row.accountName ?? "").trim().toLowerCase()}`;
}

function groupValues(row: Row, plural: string, singular: string): unknown[] {
  if (Array.isArray(row[plural])) return row[plural];
  return row[singular] === null || row[singular] === undefined ? [] : [row[singular]];
}

// 分组归并只合并展示字段。分数必须来自 scoreRecentDatabaseRow，
// 这里再算一次会让快照和实时排名各走一套权重。
export function mergeAccountScores(rows: Row[]): Row[] {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    if (isOAuthAccount(row)) continue;
    const key = accountKey(row);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return [...grouped.values()].map((accountRows) => {
    const representative = accountRows[0]!;
    const groupIds = [...new Set(accountRows.flatMap((row) => groupValues(row, "groupIds", "groupId"))
      .filter((value) => value !== null && value !== undefined))];
    const groupNames = [...new Set(accountRows.flatMap((row) => groupValues(row, "groupNames", "groupName").map(String))
      .map((value) => value.trim())
      .filter(Boolean))];
    const currentlyAvailable = accountRows.every((row) => (row.currentAvailable ?? row.currentlyAvailable) === true);
    return {
      ...representative,
      groupId: groupIds.length === 1 ? groupIds[0] : null,
      groupName: groupNames.join(" / "),
      groupIds,
      groupNames,
      currentlyAvailable,
      currentAvailable: currentlyAvailable,
      aggregation: {
        scope: "unique-account-across-groups",
        groupCount: groupNames.length,
      },
    };
  }).sort((left, right) => Number(right.score ?? -1) - Number(left.score ?? -1));
}
