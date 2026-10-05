import type { NewApiCredentialRef } from "./config";
import { normalizeUpstreamWallet } from "./upstream-valuation";

type Row = Record<string, unknown>;

export interface SharedWalletBalanceCandidate {
  remaining: number | null;
  timestamp: number;
}

/**
 * Pick one cached balance for a shared wallet.
 *
 * A zero returned by one account is weaker evidence than a positive cached
 * value from another account of the same wallet: NewAPI can report a
 * per-account failure as a successful zero while the wallet still has funds.
 * Positive values therefore win over zero values; equal kinds keep the newest
 * observation. No network request is made by this policy.
 */
export function preferSharedWalletBalance(
  previous: SharedWalletBalanceCandidate | undefined,
  candidate: SharedWalletBalanceCandidate,
): boolean {
  if (!previous) return true;
  if (previous.remaining !== null && candidate.remaining === null) return false;
  if (previous.remaining === null && candidate.remaining !== null) return true;
  if (previous.remaining !== null && candidate.remaining !== null) {
    if (previous.remaining === 0 && candidate.remaining > 0) return true;
    if (previous.remaining > 0 && candidate.remaining === 0) return false;
  }
  return candidate.timestamp >= previous.timestamp;
}

/**
 * Resolve a provider endpoint to the configured wallet identity.
 *
 * NewAPI deployments commonly expose one wallet through several API hosts
 * (for example a dashboard host and a Cloudflare/API host). The owning YAML
 * declares those aliases; the source code never embeds provider-specific
 * hostnames.
 */
export function configuredWalletKey(value: unknown, refs: NewApiCredentialRef[] = []): string {
  const normalized = normalizeUpstreamWallet(value);
  if (!normalized) return "";
  const ref = refs.find((candidate) => normalizeUpstreamWallet(candidate.baseUrl) === normalized);
  return normalizeUpstreamWallet(ref?.walletKey ?? normalized);
}

export function usageWalletKey(result: Row, refs: NewApiCredentialRef[] = []): string {
  return configuredWalletKey(result.walletKey ?? result.baseUrl, refs);
}

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function cachedResult(row: Row): Row {
  return object(row.last_success_result ?? row.result);
}

function numericQuota(result: Row): Row | null {
  const quota = object(result.quota);
  const remaining = Number(quota.remaining);
  if (result.ok !== true || String(quota.unit ?? "").toUpperCase() !== "USD" || !Number.isFinite(remaining)) return null;
  return quota;
}

/**
 * Project the newest finite balance observed for a wallet onto every cache row
 * returned to a read-only UI. A wallet may be queried through several hosts;
 * displaying per-host reads would otherwise make one wallet appear to have
 * different balances for a few seconds.
 */
export function projectSharedWalletUsageRows(rows: Row[], refs: NewApiCredentialRef[] = []): {
  results: Row[];
  lastSuccessfulResults: Array<Row | null>;
} {
  const shared = new Map<string, { result: Row; timestamp: number; remaining: number }>();
  for (const row of rows) {
    const result = cachedResult(row);
    const quota = numericQuota(result);
    const walletKey = usageWalletKey(result, refs);
    if (!quota || !walletKey) continue;
    const remaining = Number(quota.remaining);
    const timestamp = Date.parse(String(row.last_success_at ?? row.queried_at ?? result.queriedAt ?? "")) || 0;
    const previous = shared.get(walletKey);
    if (preferSharedWalletBalance(previous, { remaining, timestamp })) {
      shared.set(walletKey, { result, timestamp, remaining });
    }
  }

  const project = (row: Row, source: unknown): Row | null => {
    const result = object(source);
    if (!Object.keys(result).length) return null;
    const walletKey = configuredWalletKey(result.walletKey ?? result.baseUrl, refs);
    const sourceQuota = shared.get(walletKey)?.result;
    const quota = sourceQuota ? numericQuota(sourceQuota) : null;
    if (!quota) return result;
    return {
      ...result,
      accountId: result.accountId ?? row.account_id,
      walletKey,
      quota: { ...quota },
      ok: true,
    };
  };

  return {
    results: rows.map((row) => project(row, row.last_success_result ?? row.result) ?? {}),
    lastSuccessfulResults: rows.map((row) => project(row, row.last_success_result)),
  };
}
