import type { AppConfig } from "./config";
import { isOAuthAccount } from "./account-score-eligibility";

type Row = Record<string, unknown>;
type ProcurementPolicy = AppConfig["sub2api"]["priorityPlan"]["procurementAdvice"];

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function costRate(row: Row): number | null {
  if (typeof row.usage !== "object" || row.usage === null || Array.isArray(row.usage)) return null;
  return number((row.usage as Row).costRateCnyPerApiUsd);
}

function weightedAverage(rows: Row[], value: (row: Row) => number): number {
  const weighted = rows.reduce((total, row) => total + value(row) * Math.max(number(row.observedAttempts) ?? 0, 1), 0);
  const weight = rows.reduce((total, row) => total + Math.max(number(row.observedAttempts) ?? 0, 1), 0);
  return weight === 0 ? 0 : weighted / weight;
}

export function supplierIdentity(accountName: unknown): string | null {
  const name = String(accountName ?? "").trim().toLowerCase();
  if (!name || name.includes("@")) return null;
  const token = name.split(/\s+/u)[0]!.replace(/\/+$/u, "");
  try {
    const url = new URL(token.includes("://") ? token : `https://${token}`);
    if (!url.hostname.includes(".")) return null;
    return url.hostname.replace(/^www\./u, "");
  } catch {
    return null;
  }
}

function rowsByBillingSite(rows: Row[]): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const billingSite = supplierIdentity(row.accountName);
    if (billingSite === null) continue;
    grouped.set(billingSite, [...(grouped.get(billingSite) ?? []), row]);
  }
  return grouped;
}

function billingBlocked(row: Row, policy: ProcurementPolicy): boolean {
  const error = String(row.currentError ?? "").toLowerCase();
  return error.length > 0 && policy.billingErrorPatterns.some((pattern) => error.includes(pattern.toLowerCase()));
}

function economicScore(row: Row, minimumCost: number, maximumCost: number, qualityWeight: number, costWeight: number): number {
  const quality = number(row.score) ?? 0;
  const cost = costRate(row) ?? maximumCost;
  const rawCostScore = maximumCost === minimumCost ? 100 : 100 * (maximumCost - cost) / (maximumCost - minimumCost);
  const costScore = Math.min(100, Math.max(0, rawCostScore));
  return (quality * qualityWeight + costScore * costWeight) / (qualityWeight + costWeight);
}

export function buildProcurementAdvice(
  rows: Row[],
  config: AppConfig,
  costRange: { minimum: number; maximum: number },
): Row {
  const priorityPolicy = config.sub2api.priorityPlan;
  const policy = priorityPolicy.procurementAdvice;
  if (!policy.enabled) return { enabled: false, statusAlerts: [], recommendations: [] };
  const adviceWeight = policy.valueWeight + policy.redundancyWeight;
  if (adviceWeight <= 0) throw new Error("procurement advice valueWeight + redundancyWeight must be positive");

  const scope = rows.filter((row) => {
    const groups = Array.isArray(row.groupIds) ? row.groupIds : [];
    return !isOAuthAccount(row)
      && row.platform === priorityPolicy.platform
      && row.confidence === priorityPolicy.requiredConfidence
      && groups.some((id) => typeof id === "number" && priorityPolicy.eligibleGroupIds.includes(id))
      && number(row.score) !== null;
  });
  const scopedSites = rowsByBillingSite(scope);
  const statusAlerts = [...scopedSites.entries()]
    .map(([billingSite, siteRows]) => {
      const unavailableRows = siteRows.filter((row) => row.currentAvailable !== true);
      if (unavailableRows.length === 0) return null;
      const billing = siteRows.some((row) => billingBlocked(row, policy));
      const availableChannelCount = siteRows.length - unavailableRows.length;
      const qualityScore = weightedAverage(siteRows, (row) => number(row.score) ?? 0);
      return {
        billingSite,
        channelCount: siteRows.length,
        availableChannelCount,
        unavailableChannelCount: unavailableRows.length,
        qualityScore: Math.round(qualityScore * 10) / 10,
        kind: billing && availableChannelCount === 0 ? "billing-depleted" : "channel-unavailable",
        procurementRelevant: billing && availableChannelCount === 0
          && siteRows.some((row) => costRate(row) !== null)
          && qualityScore >= policy.minimumQualityScore,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((left, right) => Number(right.procurementRelevant) - Number(left.procurementRelevant)
      || Number(right.qualityScore ?? -1) - Number(left.qualityScore ?? -1));

  const candidates = scope.filter((row) => supplierIdentity(row.accountName) !== null && costRate(row) !== null);
  const allBySupplier = rowsByBillingSite(candidates);
  const availableSites = new Set(candidates.filter((row) => row.currentAvailable === true)
    .map((row) => supplierIdentity(row.accountName)!));
  const supplierCount = availableSites.size;
  const availableCount = availableSites.size;
  const largestSupplierShare = availableCount === 0
    ? 0
    : 1 / availableCount;
  const redundancyStatus = supplierCount < policy.minimumSupplierCount
    ? "insufficient-suppliers"
    : largestSupplierShare > policy.maximumSupplierShare
      ? "concentrated"
      : "diversified";

  const bySupplier = new Map<string, Row[]>();
  for (const row of candidates) {
    if ((number(row.score) ?? 0) < policy.minimumQualityScore) continue;
    const supplier = supplierIdentity(row.accountName)!;
    bySupplier.set(supplier, [...(bySupplier.get(supplier) ?? []), row]);
  }
  const supplierOptions = [...bySupplier.entries()].map(([supplier, supplierRows]) => {
    const currentAvailableChannels = supplierRows.filter((row) => row.currentAvailable === true).length;
    const share = availableCount === 0 || !availableSites.has(supplier) ? 0 : 1 / availableCount;
    const qualityScore = weightedAverage(supplierRows, (row) => number(row.score) ?? 0);
    const valueScore = weightedAverage(supplierRows, (row) => economicScore(
      row,
      costRange.minimum,
      costRange.maximum,
      priorityPolicy.reliabilityWeight + priorityPolicy.latencyWeight,
      priorityPolicy.costWeight,
    ));
    const redundancyScore = 100 * (1 - share);
    const procurementScore = (valueScore * policy.valueWeight + redundancyScore * policy.redundancyWeight) / adviceWeight;
    const billingRows = supplierRows.filter((row) => billingBlocked(row, policy));
    return {
      billingSite: supplier,
      action: billingRows.length > 0 && currentAvailableChannels === 0 ? "renew-balance" : "buy-additional-capacity",
      qualityScore: Math.round(qualityScore * 10) / 10,
      valueScore: Math.round(valueScore * 10) / 10,
      redundancyScore: Math.round(redundancyScore * 10) / 10,
      procurementScore: Math.round(procurementScore * 10) / 10,
      availableShare: Math.round(share * 10_000) / 10_000,
      channelCount: allBySupplier.get(supplier)?.length ?? supplierRows.length,
      qualifiedChannelCount: supplierRows.length,
      availableChannelCount: currentAvailableChannels,
      billingBlockedChannelCount: billingRows.length,
    };
  }).sort((left, right) => Number(right.action === "renew-balance") - Number(left.action === "renew-balance")
    || right.procurementScore - left.procurementScore
    || right.qualityScore - left.qualityScore
    || left.billingSite.localeCompare(right.billingSite));

  const recommendations: Row[] = [];
  const selectedPerSupplier = new Map<string, number>();
  for (const option of supplierOptions) {
    if (recommendations.length >= policy.recommendationLimit) break;
    const selected = selectedPerSupplier.get(option.billingSite) ?? 0;
    if (selected >= policy.maximumRecommendationsPerSupplier) continue;
    recommendations.push(option);
    selectedPerSupplier.set(option.billingSite, selected + 1);
  }

  return {
    enabled: true,
    policy,
    summary: {
      evaluatedAccountCount: scope.length,
      unavailableAccountCount: statusAlerts.length,
      billingDepletedAccountCount: statusAlerts.filter((alert) => alert.kind === "billing-depleted").length,
      stableSupplierCount: supplierCount,
      currentlyAvailableSiteCount: availableCount,
      largestSupplierShare: Math.round(largestSupplierShare * 10_000) / 10_000,
      redundancyStatus,
      unknownSupplierCount: scope.filter((row) => supplierIdentity(row.accountName) === null).length,
      unknownCostCount: scope.filter((row) => costRate(row) === null).length,
    },
    statusAlerts,
    recommendations,
    mutation: false,
  };
}
