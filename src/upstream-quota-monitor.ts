import { normalizeUpstreamWallet } from "./upstream-valuation";

type Row = Record<string, unknown>;

export interface UpstreamQuotaSample {
  sampledAt: string;
  walletKey: string;
  accountId: number;
  schedulable: boolean;
  status: string;
  provider: string;
  probeOk: boolean;
  remainingUsd: number | null;
  cnyPerUsd: number;
  remainingCny: number | null;
  sourceQueriedAt: string | null;
  apiAmountUsdTotal?: number | null;
  walletApiAmountUsdTotal?: number | null;
}

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

interface WalletCostObservation {
  walletKey: string;
  endedAt: number;
  consumedCny: number;
  apiAmountUsd: number;
}

function sameRate(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.0000005;
}

function walletCostObservations(samples: UpstreamQuotaSample[]): WalletCostObservation[] {
  const byWallet = new Map<string, UpstreamQuotaSample[]>();
  for (const sample of samples) {
    if (sample.remainingCny === null || sample.walletApiAmountUsdTotal === null
      || sample.walletApiAmountUsdTotal === undefined) continue;
    const rows = byWallet.get(sample.walletKey) ?? [];
    rows.push(sample);
    byWallet.set(sample.walletKey, rows);
  }
  const observations: WalletCostObservation[] = [];
  for (const [walletKey, rows] of byWallet) {
    rows.sort((left, right) => Date.parse(left.sampledAt) - Date.parse(right.sampledAt));
    let anchor = rows[0];
    for (const current of rows.slice(1)) {
      if (!anchor) {
        anchor = current;
        continue;
      }
      const anchorBalance = anchor.remainingCny!;
      const currentBalance = current.remainingCny!;
      const anchorOutput = anchor.walletApiAmountUsdTotal!;
      const currentOutput = current.walletApiAmountUsdTotal!;
      if (!sameRate(anchor.cnyPerUsd, current.cnyPerUsd)) {
        anchor = current;
        continue;
      }
      if (currentOutput < anchorOutput || currentBalance > anchorBalance) {
        anchor = current;
        continue;
      }
      if (currentBalance >= anchorBalance) continue;
      const apiAmountUsd = currentOutput - anchorOutput;
      if (apiAmountUsd > 0) {
        observations.push({
          walletKey,
          endedAt: Date.parse(current.sampledAt),
          consumedCny: anchorBalance - currentBalance,
          apiAmountUsd,
        });
      }
      anchor = current;
    }
  }
  return observations;
}

export function buildQuotaSamples(
  results: Row[],
  sampledAt: string,
  rateForWallet: (wallet: string) => number,
): UpstreamQuotaSample[] {
  const wallets = new Map<string, UpstreamQuotaSample>();
  for (const result of results) {
    const walletKey = normalizeUpstreamWallet(result.baseUrl);
    const accountId = Number(result.accountId);
    if (!walletKey || !Number.isSafeInteger(accountId) || accountId <= 0) continue;
    const quota = object(result.quota);
    const remainingUsd = result.ok === true && quota.unit === "USD" ? finite(quota.remaining) : null;
    const cnyPerUsd = rateForWallet(walletKey);
    const candidate: UpstreamQuotaSample = {
      sampledAt,
      walletKey,
      accountId,
      schedulable: result.status === "active" && result.schedulable === true,
      status: String(result.status ?? "unknown"),
      provider: String(result.provider ?? "unknown"),
      probeOk: result.ok === true,
      remainingUsd,
      cnyPerUsd,
      remainingCny: remainingUsd === null ? null : remainingUsd * cnyPerUsd,
      sourceQueriedAt: typeof result.queriedAt === "string" ? result.queriedAt : null,
      walletApiAmountUsdTotal: finite(result.apiAmountUsdTotal),
    };
    const current = wallets.get(walletKey);
    if (!current) wallets.set(walletKey, candidate);
    else {
      current.schedulable ||= candidate.schedulable;
      current.walletApiAmountUsdTotal = current.walletApiAmountUsdTotal === null
        || current.walletApiAmountUsdTotal === undefined
        || candidate.walletApiAmountUsdTotal === null
        || candidate.walletApiAmountUsdTotal === undefined
        ? null
        : current.walletApiAmountUsdTotal + candidate.walletApiAmountUsdTotal;
      if (current.remainingCny === null && candidate.remainingCny !== null) {
        current.accountId = candidate.accountId;
        current.remainingUsd = candidate.remainingUsd;
        current.remainingCny = candidate.remainingCny;
        current.provider = candidate.provider;
        current.probeOk = candidate.probeOk;
        current.sourceQueriedAt = candidate.sourceQueriedAt;
      }
    }
  }
  return [...wallets.values()];
}

export function summarizeQuotaSamples(samples: UpstreamQuotaSample[], windowHours = 1) {
  const latestAt = samples.reduce((latest, row) => Math.max(latest, Date.parse(row.sampledAt)), 0);
  if (!latestAt) return {
    sampledAt: null, totalRemainingCny: null, schedulableRemainingCny: null,
    unschedulableRemainingCny: null, knownWallets: 0, unknownWallets: 0,
    consumedCny: null, apiAmountUsd: null, realtimeCostCnyPerApiUsd: null,
    sampleRealtimeCostCnyPerApiUsd: null, costConsumedCny: 0, costApiAmountUsd: 0,
    costCoverageWallets: 0, burnWindowHours: 0, estimatedAvailableHours: null,
    burnCoverageWallets: 0, insufficientBurnWallets: 0, warning: "尚无额度采样",
    walletDistribution: [],
  };
  const latestRows = samples.filter((row) => Date.parse(row.sampledAt) === latestAt);
  const known = latestRows.filter((row) => row.remainingCny !== null);
  const total = known.reduce((sum, row) => sum + Math.max(0, row.remainingCny!), 0);
  const schedulable = known.filter((row) => row.schedulable)
    .reduce((sum, row) => sum + Math.max(0, row.remainingCny!), 0);
  const walletDistribution = known.map((row) => ({
    wallet: row.walletKey,
    remainingCny: Math.max(0, row.remainingCny!),
    remainingUsd: row.remainingUsd,
    schedulable: row.schedulable,
    ratio: total > 0 ? Math.round(Math.max(0, row.remainingCny!) / total * 1_000_000) / 1_000_000 : 0,
  })).sort((left, right) => right.remainingCny - left.remainingCny || left.wallet.localeCompare(right.wallet));
  const byWallet = new Map<string, UpstreamQuotaSample[]>();
  for (const sample of samples) {
    if (sample.remainingCny === null || Date.parse(sample.sampledAt) < latestAt - windowHours * 3_600_000) continue;
    const rows = byWallet.get(sample.walletKey) ?? [];
    rows.push(sample);
    byWallet.set(sample.walletKey, rows);
  }
  let consumed = 0;
  let coverage = 0;
  for (const rows of byWallet.values()) {
    rows.sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
    const latestRate = rows.at(-1)!.cnyPerUsd;
    let segmentStart = rows.length - 1;
    while (segmentStart > 0 && sameRate(rows[segmentStart - 1]!.cnyPerUsd, latestRate)) segmentStart -= 1;
    const comparableRows = rows.slice(segmentStart);
    if (comparableRows.length < 2) continue;
    coverage += 1;
    consumed += Math.max(0, comparableRows[0]!.remainingCny! - comparableRows.at(-1)!.remainingCny!);
  }
  const insufficient = known.length - coverage;
  const burnKnown = coverage > 0;
  const productionPoints = [...new Map(samples
    .filter((row) => Date.parse(row.sampledAt) >= latestAt - windowHours * 3_600_000
      && row.apiAmountUsdTotal !== null && row.apiAmountUsdTotal !== undefined)
    .map((row) => [row.sampledAt, row.apiAmountUsdTotal!])).entries()]
    .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
  const apiAmountUsd = productionPoints.length >= 2
    ? Math.max(0, productionPoints.at(-1)![1] - productionPoints[0]![1]) : null;
  const burnWindowHours = productionPoints.length >= 2
    ? Math.max(0, (Date.parse(productionPoints.at(-1)![0]) - Date.parse(productionPoints[0]![0])) / 3_600_000)
    : 0;
  const cutoffAt = latestAt - windowHours * 3_600_000;
  const costObservations = walletCostObservations(samples)
    .filter((observation) => observation.endedAt >= cutoffAt && observation.endedAt <= latestAt);
  const currentCostObservations = costObservations.filter((observation) => observation.endedAt === latestAt);
  const costConsumedCny = costObservations.reduce((sum, observation) => sum + observation.consumedCny, 0);
  const costApiAmountUsd = costObservations.reduce((sum, observation) => sum + observation.apiAmountUsd, 0);
  const sampleCostConsumedCny = currentCostObservations.reduce((sum, observation) => sum + observation.consumedCny, 0);
  const sampleCostApiAmountUsd = currentCostObservations.reduce((sum, observation) => sum + observation.apiAmountUsd, 0);
  const costCoverageWallets = new Set(costObservations.map((observation) => observation.walletKey)).size;
  const latestWalletOutputMissing = known.filter((row) => row.walletApiAmountUsdTotal === null
    || row.walletApiAmountUsdTotal === undefined).length;
  const warnings = [
    latestRows.length > known.length ? `${latestRows.length - known.length} 个 wallet 余额未知` : null,
    latestWalletOutputMissing > 0 ? `${latestWalletOutputMissing} 个 wallet 缺少归属产出样本` : null,
    costCoverageWallets === 0 ? "最近一小时缺少可配对的 wallet 消耗与产出" : null,
  ].filter(Boolean);
  return {
    sampledAt: new Date(latestAt).toISOString(),
    totalRemainingCny: total,
    schedulableRemainingCny: schedulable,
    unschedulableRemainingCny: Math.max(0, total - schedulable),
    knownWallets: known.length,
    unknownWallets: latestRows.length - known.length,
    consumedCny: burnKnown ? consumed : null,
    apiAmountUsd,
    realtimeCostCnyPerApiUsd: costConsumedCny > 0 && costApiAmountUsd > 0
      ? costConsumedCny / costApiAmountUsd : null,
    sampleRealtimeCostCnyPerApiUsd: sampleCostConsumedCny > 0 && sampleCostApiAmountUsd > 0
      ? sampleCostConsumedCny / sampleCostApiAmountUsd : null,
    costConsumedCny,
    costApiAmountUsd,
    costCoverageWallets,
    burnWindowHours,
    estimatedAvailableHours: burnKnown && consumed > 0 && burnWindowHours > 0
      ? schedulable / (consumed / burnWindowHours) : null,
    burnCoverageWallets: coverage,
    insufficientBurnWallets: Math.max(0, insufficient),
    warning: warnings.length > 0 ? warnings.join("；")
      : !burnKnown ? "最近一小时有效样本不足，暂不可估算消耗" : null,
    walletDistribution,
  };
}

export function quotaHistory(samples: UpstreamQuotaSample[], windowHours = 1, displayHours = 8) {
  const timestamps = [...new Set(samples.map((row) => row.sampledAt))]
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const history = timestamps.map((sampledAt, index) => {
    const end = Date.parse(sampledAt);
    const apiAmountUsdTotal = samples.find((row) => row.sampledAt === sampledAt
      && row.apiAmountUsdTotal !== null && row.apiAmountUsdTotal !== undefined)?.apiAmountUsdTotal ?? null;
    const previousAt = timestamps[index - 1];
    const previousApiAmountUsdTotal = previousAt === undefined ? null : samples.find((row) => row.sampledAt === previousAt
      && row.apiAmountUsdTotal !== null && row.apiAmountUsdTotal !== undefined)?.apiAmountUsdTotal ?? null;
    const sampleElapsedHours = previousAt === undefined ? 0 : (end - Date.parse(previousAt)) / 3_600_000;
    const sampleApiAmountUsdPerHour = apiAmountUsdTotal !== null && previousApiAmountUsdTotal !== null && sampleElapsedHours > 0
      ? Math.max(0, apiAmountUsdTotal - previousApiAmountUsdTotal) / sampleElapsedHours
      : null;
    const historical = samples.filter((row) => {
      const at = Date.parse(row.sampledAt);
      return at <= end;
    });
    const summary = summarizeQuotaSamples(historical, windowHours);
    return {
      sampledAt,
      totalRemainingCny: summary.totalRemainingCny,
      schedulableRemainingCny: summary.schedulableRemainingCny,
      consumedCny: summary.consumedCny,
      apiAmountUsd: summary.apiAmountUsd,
      sampleApiAmountUsdPerHour,
      sampleRealtimeCostCnyPerApiUsd: summary.sampleRealtimeCostCnyPerApiUsd,
      rollingApiAmountUsdPerHour: summary.apiAmountUsd !== null && summary.burnWindowHours > 0
        ? summary.apiAmountUsd / summary.burnWindowHours
        : null,
      realtimeCostCnyPerApiUsd: summary.realtimeCostCnyPerApiUsd,
    };
  });
  const latestAt = Date.parse(timestamps.at(-1) ?? "");
  if (!Number.isFinite(latestAt)) return [];
  const displayCutoff = latestAt - displayHours * 3_600_000;
  return history.filter((point) => Date.parse(point.sampledAt) >= displayCutoff);
}
