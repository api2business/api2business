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
}

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
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
    };
    const current = wallets.get(walletKey);
    if (!current) wallets.set(walletKey, candidate);
    else {
      current.schedulable ||= candidate.schedulable;
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
    consumedCny: null, estimatedAvailableHours: null, burnCoverageWallets: 0,
    insufficientBurnWallets: 0, warning: "尚无额度采样",
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
    if (rows.length < 2) continue;
    coverage += 1;
    consumed += Math.max(0, rows[0]!.remainingCny! - rows.at(-1)!.remainingCny!);
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
  return {
    sampledAt: new Date(latestAt).toISOString(),
    totalRemainingCny: total,
    schedulableRemainingCny: schedulable,
    unschedulableRemainingCny: Math.max(0, total - schedulable),
    knownWallets: known.length,
    unknownWallets: latestRows.length - known.length,
    consumedCny: burnKnown ? consumed : null,
    apiAmountUsd,
    realtimeCostCnyPerApiUsd: burnKnown && consumed > 0 && apiAmountUsd !== null && apiAmountUsd > 0
      ? consumed / apiAmountUsd : null,
    burnWindowHours,
    estimatedAvailableHours: burnKnown && consumed > 0 && burnWindowHours > 0
      ? schedulable / (consumed / burnWindowHours) : null,
    burnCoverageWallets: coverage,
    insufficientBurnWallets: Math.max(0, insufficient),
    warning: latestRows.length > known.length
      ? `${latestRows.length - known.length} 个 wallet 余额未知`
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
    const sampleWindow = previousAt === undefined ? [] : samples.filter((row) => row.sampledAt === previousAt || row.sampledAt === sampledAt);
    const sampleSummary = summarizeQuotaSamples(sampleWindow, sampleElapsedHours);
    const window = samples.filter((row) => {
      const at = Date.parse(row.sampledAt);
      return at <= end && at >= end - windowHours * 3_600_000;
    });
    const summary = summarizeQuotaSamples(window, windowHours);
    return {
      sampledAt,
      totalRemainingCny: summary.totalRemainingCny,
      schedulableRemainingCny: summary.schedulableRemainingCny,
      consumedCny: summary.consumedCny,
      apiAmountUsd: summary.apiAmountUsd,
      sampleApiAmountUsdPerHour,
      sampleRealtimeCostCnyPerApiUsd: sampleSummary.realtimeCostCnyPerApiUsd,
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
