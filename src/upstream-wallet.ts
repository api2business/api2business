import type { NewApiCredentialRef } from "./config";
import { normalizeUpstreamWallet } from "./upstream-valuation";

type Row = Record<string, unknown>;

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
