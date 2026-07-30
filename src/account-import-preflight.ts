import { createHash } from "node:crypto";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

interface AccountRow extends Record<string, unknown> {
  row_kind: unknown;
  id: unknown;
  user_id: unknown;
  access_token_sha256: unknown;
  priority: unknown;
  concurrency: unknown;
  proxy_id: unknown;
  proxy_name: unknown;
  group_ids: unknown;
}

interface ImportIdentity {
  index: number;
  userId: string;
  accessTokenSha256: string;
}

export interface AccountImportPreflightSettings {
  priority: number;
  capacity: number;
  groupIds: number[];
  sourceProxyId: number;
}

export interface AccountImportPreflightPlan {
  content: string;
  sourceIndexes: number[];
  skipped: Array<{ index: number; accountId: number }>;
  selectedProxyId: number;
  proxyCandidateIds: number[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value
    : typeof value === "bigint" ? Number(value)
    : typeof value === "string" ? Number(value)
    : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function identity(account: unknown, index: number): ImportIdentity {
  const credentials = record(record(account)?.credentials);
  const accessToken = text(credentials?.access_token);
  return {
    index,
    userId: text(credentials?.chatgpt_user_id),
    accessTokenSha256: accessToken ? createHash("sha256").update(accessToken).digest("hex") : "",
  };
}

function groupIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(integer).filter((item): item is number => item !== null).sort((a, b) => a - b);
}

function baseAligned(row: AccountRow, settings: AccountImportPreflightSettings): boolean {
  const id = integer(row.id);
  const groups = new Set(groupIds(row.group_ids));
  if (id === null || integer(row.priority) !== settings.priority || integer(row.concurrency) !== settings.capacity) return false;
  if (settings.groupIds.some((groupId) => !groups.has(groupId))) return false;
  return true;
}

export async function accountImportPreflight(
  content: string,
  settings: AccountImportPreflightSettings,
  reads: Sub2ApiReadClient,
): Promise<AccountImportPreflightPlan> {
  const payload = JSON.parse(content) as Record<string, unknown>;
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const identities = accounts.map(identity);
  const userIds = [...new Set(identities.map((item) => item.userId).filter(Boolean))].sort();
  const accessHashes = [...new Set(identities.map((item) => item.accessTokenSha256).filter(Boolean))].sort();
  const key = createHash("sha256").update(JSON.stringify({ userIds, accessHashes, settings })).digest("hex");
  const result = await reads.query<AccountRow>({
    key: `account-import-preflight:${key}`,
    kind: "account-import-preflight",
    priority: "manual",
    cacheMode: "bypass-cache",
    sql: `
      WITH source_proxy AS (
        SELECT host, port FROM proxies
        WHERE id = $3::bigint AND deleted_at IS NULL
      ), matching_proxies AS (
        SELECT p.id FROM proxies p
        JOIN source_proxy source ON source.host = p.host AND source.port = p.port
        WHERE p.id >= 3 AND p.deleted_at IS NULL AND p.status = 'active'
      ), matched_accounts AS (
        SELECT
        a.id,
        COALESCE(a.credentials->>'chatgpt_user_id', '') AS user_id,
        COALESCE(a.extra->>'access_token_sha256', '') AS access_token_sha256,
        a.priority,
        a.concurrency,
        a.proxy_id,
        COALESCE(p.name, '') AS proxy_name,
        COALESCE(array_agg(DISTINCT ag.group_id) FILTER (WHERE ag.group_id IS NOT NULL), '{}') AS group_ids
      FROM accounts a
      LEFT JOIN account_groups ag ON ag.account_id = a.id
      LEFT JOIN proxies p ON p.id = a.proxy_id AND p.deleted_at IS NULL
      WHERE a.deleted_at IS NULL
        AND a.platform = 'openai'
        AND a.type = 'oauth'
        AND (
          COALESCE(a.credentials->>'chatgpt_user_id', '') = ANY(string_to_array($1, ','))
          OR COALESCE(a.extra->>'access_token_sha256', '') = ANY(string_to_array($2, ','))
        )
        GROUP BY a.id, p.name
      )
      SELECT 'account'::text AS row_kind,
        account.id, account.user_id, account.access_token_sha256,
        account.priority, account.concurrency, account.proxy_id, account.proxy_name, account.group_ids
      FROM matched_accounts account
      UNION ALL
      SELECT 'proxy'::text AS row_kind,
        proxy.id, ''::text, ''::text, NULL::int, NULL::int, NULL::bigint, ''::text, '{}'::bigint[]
      FROM matching_proxies proxy
      ORDER BY row_kind, id
    `,
    parameters: [userIds.join(","), accessHashes.join(","), settings.sourceProxyId],
  });
  const proxyCandidateIds = result.rows.filter((row) => row.row_kind === "proxy")
    .map((row) => integer(row.id)).filter((id): id is number => id !== null);
  if (proxyCandidateIds.length === 0) throw new Error("代理池中没有与基准代理相同 host/port 的可用代理");
  const selectedProxyId = proxyCandidateIds[Math.floor(Math.random() * proxyCandidateIds.length)]!;
  const byUser = new Map<string, AccountRow[]>();
  const byAccess = new Map<string, AccountRow[]>();
  for (const row of result.rows.filter((item) => item.row_kind === "account")) {
    const userId = text(row.user_id);
    const accessHash = text(row.access_token_sha256);
    if (userId) byUser.set(userId, [...(byUser.get(userId) ?? []), row]);
    if (accessHash) byAccess.set(accessHash, [...(byAccess.get(accessHash) ?? []), row]);
  }
  const skipped: AccountImportPreflightPlan["skipped"] = [];
  const sourceIndexes: number[] = [];
  const remaining: unknown[] = [];
  for (let offset = 0; offset < accounts.length; offset += 1) {
    const item = identities[offset]!;
    const matches = item.userId ? byUser.get(item.userId) ?? [] : byAccess.get(item.accessTokenSha256) ?? [];
    if (matches.length === 1 && baseAligned(matches[0]!, settings)
      && proxyCandidateIds.includes(integer(matches[0]!.proxy_id) ?? -1)) {
      const match = matches[0]!;
      const existing = { index: offset + 1, accountId: integer(match.id)! };
      skipped.push(existing);
      continue;
    }
    remaining.push(accounts[offset]);
    sourceIndexes.push(offset + 1);
  }
  return {
    content: JSON.stringify({ ...payload, accounts: remaining }),
    sourceIndexes,
    skipped,
    selectedProxyId,
    proxyCandidateIds,
  };
}
