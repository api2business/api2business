import type { Sub2ApiReadClient } from "./sub2api-read-executor";

type Row = Record<string, unknown>;

function integer(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function integerArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(integer).filter((item): item is number => item !== null).sort((left, right) => left - right)
    : [];
}

export async function inspectAccounts(accountIds: number[], reads: Sub2ApiReadClient): Promise<Record<string, unknown>> {
  const ids = [...new Set(accountIds)].sort((left, right) => left - right);
  if (ids.length < 1 || ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error("accounts inspect requires 1..100 stable positive account IDs");
  }
  const query = await reads.query<Row>({
    key: `accounts-inspect:${ids.join(",")}`,
    kind: "accounts-inspect",
    priority: "manual",
    cacheMode: "bypass-cache",
    sql: `
      SELECT
        a.id, a.name, a.platform, a.type, a.status, a.schedulable, a.priority,
        a.concurrency AS capacity, a.proxy_id,
        COALESCE(p.name, '') AS proxy_name,
        COALESCE(p.status, '') AS proxy_status,
        COALESCE(array_agg(DISTINCT ag.group_id) FILTER (WHERE ag.group_id IS NOT NULL), '{}') AS group_ids,
        COALESCE(array_agg(DISTINCT g.name) FILTER (WHERE g.name IS NOT NULL), '{}') AS group_names
      FROM accounts a
      LEFT JOIN account_groups ag ON ag.account_id = a.id
      LEFT JOIN groups g ON g.id = ag.group_id AND g.deleted_at IS NULL
      LEFT JOIN proxies p ON p.id = a.proxy_id AND p.deleted_at IS NULL
      WHERE a.deleted_at IS NULL
        AND a.id = ANY(string_to_array($1, ',')::bigint[])
      GROUP BY a.id, p.name, p.status
      ORDER BY a.id
    `,
    parameters: [ids.join(",")],
  });
  const accounts = query.rows.map((row) => ({
    id: integer(row.id),
    name: String(row.name ?? ""),
    platform: String(row.platform ?? "").toLowerCase(),
    type: String(row.type ?? "").toLowerCase(),
    status: String(row.status ?? ""),
    schedulable: row.schedulable === true,
    priority: integer(row.priority),
    capacity: integer(row.capacity),
    proxyId: integer(row.proxy_id),
    proxyName: row.proxy_name ? String(row.proxy_name) : null,
    proxyStatus: row.proxy_status ? String(row.proxy_status) : null,
    groupIds: integerArray(row.group_ids),
    groupNames: Array.isArray(row.group_names) ? row.group_names.map(String) : [],
  }));
  const foundIds = new Set(accounts.map((row) => row.id));
  return {
    ok: true, selected: ids.length, found: accounts.length,
    missingIds: ids.filter((id) => !foundIds.has(id)),
    databaseQueries: query.cached ? 0 : 1,
    queueDurationMs: query.queueDurationMs, queryDurationMs: query.queryDurationMs,
    accounts,
  };
}

export async function verifyImportedAccounts(
  accountIds: number[],
  settings: { priority: number; capacity: number; groupIds: number[]; platform?: "openai" | "grok" },
  proxyCandidateIds: number[],
  reads: Sub2ApiReadClient,
  proxyOptions: { sharedProxyId?: number; strictProxyAccountIds?: number[] } = {},
): Promise<Record<string, unknown>> {
  const inspected = await inspectAccounts(accountIds, reads);
  const rows = Array.isArray(inspected.accounts) ? inspected.accounts as Row[] : [];
  const strictProxyAccountIds = new Set(proxyOptions.strictProxyAccountIds ?? []);
  const accounts = rows.map((row) => {
    const reasons: string[] = [];
    if (settings.platform && String(row.platform) !== settings.platform) reasons.push("platform-mismatch");
    if (String(row.type) !== "oauth") reasons.push("type-mismatch");
    if (Number(row.priority) !== settings.priority) reasons.push("priority-mismatch");
    if (Number(row.capacity) !== settings.capacity) reasons.push("capacity-mismatch");
    const groups = integerArray(row.groupIds);
    if (settings.groupIds.some((id) => !groups.includes(id))) reasons.push("group-mismatch");
    if (!proxyCandidateIds.includes(Number(row.proxyId))) reasons.push(row.proxyId === null ? "proxy-unbound" : "proxy-outside-pool");
    else if (proxyOptions.sharedProxyId !== undefined && strictProxyAccountIds.has(Number(row.id))
      && Number(row.proxyId) !== proxyOptions.sharedProxyId) reasons.push("shared-proxy-mismatch");
    return { ...row, aligned: reasons.length === 0, reasons };
  });
  const missingIds = integerArray(inspected.missingIds);
  const aligned = accounts.filter((row) => row.aligned === true).length;
  return { ...inspected, ok: missingIds.length === 0 && aligned === accounts.length, aligned, accounts };
}
