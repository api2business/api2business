import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface UpstreamValuationPolicy {
  currency: "CNY";
  defaultCnyPerApiUsd: number;
  walletCnyPerApiUsd: Record<string, number>;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeUpstreamWallet(value: unknown): string {
  const url = String(value ?? "").trim().split(/\s+/u)[0] ?? "";
  return url.replace(/\/v1\/?$/u, "").replace(/\/$/u, "");
}

export function upstreamBalanceRateByWallet(
  wallet: string,
  defaultRate: number,
  overrides: Record<string, unknown>,
): number {
  const configured = Object.entries(overrides).find(([key]) => normalizeUpstreamWallet(key) === wallet)?.[1];
  const rate = configured === undefined ? defaultRate : Number(configured);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`profit.upstreamBalanceCnyPerApiUsdByWallet.${wallet} must be positive`);
  }
  return rate;
}

export function readUpstreamValuationPolicy(ledgerPath: string): UpstreamValuationPolicy {
  const root = object(parse(readFileSync(ledgerPath, "utf8")));
  const profit = object(root.profit);
  const defaultRate = Number(profit.upstreamBalanceCnyPerApiUsd ?? 1);
  if (!Number.isFinite(defaultRate) || defaultRate <= 0) {
    throw new Error("profit.upstreamBalanceCnyPerApiUsd must be positive");
  }
  const configured = object(profit.upstreamBalanceCnyPerApiUsdByWallet);
  const walletCnyPerApiUsd = Object.fromEntries(Object.entries(configured).map(([wallet, value]) => {
    const normalized = normalizeUpstreamWallet(wallet);
    return [normalized, upstreamBalanceRateByWallet(normalized, defaultRate, configured)];
  }));
  return { currency: "CNY", defaultCnyPerApiUsd: defaultRate, walletCnyPerApiUsd };
}
