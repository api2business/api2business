import type { AppConfig } from "./config";

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
    return row.platform === priorityPolicy.platform
      && row.confidence === priorityPolicy.requiredConfidence
      && groups.some((id) => typeof id === "number" && priorityPolicy.eligibleGroupIds.includes(id))
      && number(row.score) !== null;
  });
  const statusAlerts = scope
    .filter((row) => row.currentAvailable !== true)
    .map((row) => {
      const billing = billingBlocked(row, policy);
      const supplier = supplierIdentity(row.accountName);
      return {
        accountId: row.accountId,
        accountName: row.accountName,
        supplier,
        status: row.status,
        schedulable: row.schedulable,
        qualityScore: row.score,
        kind: billing ? "billing-depleted" : "account-unavailable",
        procurementRelevant: billing
          && supplier !== null
          && costRate(row) !== null
          && (number(row.score) ?? 0) >= policy.minimumQualityScore,
      };
    })
    .sort((left, right) => Number(right.procurementRelevant) - Number(left.procurementRelevant)
      || Number(right.qualityScore ?? -1) - Number(left.qualityScore ?? -1));

  const candidates = scope.filter((row) => supplierIdentity(row.accountName) !== null && costRate(row) !== null);
  const available = candidates.filter((row) => row.currentAvailable === true);
  const availableBySupplier = new Map<string, number>();
  for (const row of available) {
    const supplier = supplierIdentity(row.accountName)!;
    availableBySupplier.set(supplier, (availableBySupplier.get(supplier) ?? 0) + 1);
  }
  const supplierCount = availableBySupplier.size;
  const availableCount = available.length;
  const largestSupplierShare = availableCount === 0
    ? 0
    : Math.max(0, ...availableBySupplier.values()) / availableCount;
  const redundancyStatus = supplierCount < policy.minimumSupplierCount
    ? "insufficient-suppliers"
    : largestSupplierShare > policy.maximumSupplierShare
      ? "concentrated"
      : "diversified";

  const bySupplier = new Map<string, Row[]>();
  const allBySupplier = new Map<string, Row[]>();
  for (const row of candidates) {
    const supplier = supplierIdentity(row.accountName)!;
    allBySupplier.set(supplier, [...(allBySupplier.get(supplier) ?? []), row]);
  }
  for (const row of candidates) {
    if ((number(row.score) ?? 0) < policy.minimumQualityScore) continue;
    const supplier = supplierIdentity(row.accountName)!;
    bySupplier.set(supplier, [...(bySupplier.get(supplier) ?? []), row]);
  }
  const supplierOptions = [...bySupplier.entries()].map(([supplier, supplierRows]) => {
    const currentAvailableAccounts = availableBySupplier.get(supplier) ?? 0;
    const share = availableCount === 0 ? 0 : (availableBySupplier.get(supplier) ?? 0) / availableCount;
    const qualityScore = weightedAverage(supplierRows, (row) => number(row.score) ?? 0);
    const valueScore = weightedAverage(supplierRows, (row) => economicScore(
      row,
      costRange.minimum,
      costRange.maximum,
      priorityPolicy.qualityWeight,
      priorityPolicy.costWeight,
    ));
    const redundancyScore = 100 * (1 - share);
    const procurementScore = (valueScore * policy.valueWeight + redundancyScore * policy.redundancyWeight) / adviceWeight;
    const billingRows = supplierRows.filter((row) => billingBlocked(row, policy));
    return {
      supplier,
      action: billingRows.length > 0 ? "renew-balance" : "buy-additional-capacity",
      qualityScore: Math.round(qualityScore * 10) / 10,
      valueScore: Math.round(valueScore * 10) / 10,
      redundancyScore: Math.round(redundancyScore * 10) / 10,
      procurementScore: Math.round(procurementScore * 10) / 10,
      availableShare: Math.round(share * 10_000) / 10_000,
      historicalAccountCount: allBySupplier.get(supplier)?.length ?? supplierRows.length,
      qualifiedAccountCount: supplierRows.length,
      currentlyAvailableAccountCount: currentAvailableAccounts,
      billingBlockedAccountCount: billingRows.length,
      accountIds: supplierRows.map((row) => row.accountId),
      billingAccountIds: billingRows.map((row) => row.accountId),
    };
  }).sort((left, right) => Number(right.action === "renew-balance") - Number(left.action === "renew-balance")
    || right.procurementScore - left.procurementScore
    || right.qualityScore - left.qualityScore
    || left.supplier.localeCompare(right.supplier));

  const recommendations: Row[] = [];
  const selectedPerSupplier = new Map<string, number>();
  for (const option of supplierOptions) {
    if (recommendations.length >= policy.recommendationLimit) break;
    const selected = selectedPerSupplier.get(option.supplier) ?? 0;
    if (selected >= policy.maximumRecommendationsPerSupplier) continue;
    recommendations.push(option);
    selectedPerSupplier.set(option.supplier, selected + 1);
  }

  return {
    enabled: true,
    policy,
    summary: {
      evaluatedAccountCount: scope.length,
      unavailableAccountCount: statusAlerts.length,
      billingDepletedAccountCount: statusAlerts.filter((alert) => alert.kind === "billing-depleted").length,
      stableSupplierCount: supplierCount,
      currentlyAvailableAccountCount: availableCount,
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
