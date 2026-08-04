export type OAuthRuntimeProfile = "codex" | "grok";

export interface OAuthRuntimeSample {
  sampledAt: string;
  profile: OAuthRuntimeProfile;
  apiAmountUsdTotal: number;
  expectedApiAmountUsd: number | null;
  remainingExpectedApiAmountUsd: number | null;
  accountCount: number;
  normalCount: number;
  rateLimitedCount: number;
  errorCount: number;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

export function buildOAuthRuntimeSample(
  result: Record<string, unknown>,
  profile: OAuthRuntimeProfile,
  sampledAt: string,
): OAuthRuntimeSample {
  const pool = result.pool && typeof result.pool === "object" ? result.pool as Record<string, unknown> : {};
  const total = pool.total && typeof pool.total === "object" ? pool.total as Record<string, unknown> : {};
  const health = result.health && typeof result.health === "object" ? result.health as Record<string, unknown> : {};
  return {
    sampledAt,
    profile,
    apiAmountUsdTotal: Math.max(0, finite(total.apiAmountUsd) ?? 0),
    expectedApiAmountUsd: finite(total.expectedApiAmountUsd),
    remainingExpectedApiAmountUsd: finite(total.remainingExpectedApiAmountUsd),
    accountCount: Math.max(0, Number(health.accountCount ?? total.accountCount ?? 0)),
    normalCount: Math.max(0, Number(health.normalCount ?? 0)),
    rateLimitedCount: Math.max(0, Number(health.rateLimitedCount ?? 0)),
    errorCount: Math.max(0, Number(health.errorCount ?? 0)),
  };
}

export function summarizeOAuthRuntimeSamples(samples: OAuthRuntimeSample[], windowHours = 1) {
  const ordered = [...samples].sort((left, right) => Date.parse(left.sampledAt) - Date.parse(right.sampledAt));
  const latest = ordered.at(-1);
  if (!latest) return {
    sampledAt: null,
    apiAmountUsdTotal: null,
    expectedApiAmountUsd: null,
    remainingExpectedApiAmountUsd: null,
    consumedApiAmountUsd: null,
    apiAmountUsdPerHour: null,
    burnWindowHours: 0,
    estimatedAvailableHours: null,
    accountCount: 0,
    normalCount: 0,
    rateLimitedCount: 0,
    errorCount: 0,
    warning: "尚无 OAuth 产出采样",
  };
  const cutoff = Date.parse(latest.sampledAt) - windowHours * 3_600_000;
  const window = ordered.filter((sample) => Date.parse(sample.sampledAt) >= cutoff);
  let consumed = 0;
  let elapsedHours = 0;
  let validIntervals = 0;
  let resetIntervals = 0;
  for (let index = 1; index < window.length; index += 1) {
    const previous = window[index - 1]!;
    const current = window[index]!;
    const intervalHours = (Date.parse(current.sampledAt) - Date.parse(previous.sampledAt)) / 3_600_000;
    const delta = current.apiAmountUsdTotal - previous.apiAmountUsdTotal;
    // 号池成员变化会重写累计投影；将该区间视为基线重置，避免导入或退役虚增、抹除产出。
    if (intervalHours <= 0 || current.accountCount !== previous.accountCount || delta < 0) {
      resetIntervals += 1;
      continue;
    }
    consumed += delta;
    elapsedHours += intervalHours;
    validIntervals += 1;
  }
  const hasRate = validIntervals > 0 && elapsedHours > 0;
  const consumedValue = hasRate ? consumed : null;
  const rate = hasRate ? consumed / elapsedHours : null;
  return {
    sampledAt: latest.sampledAt,
    apiAmountUsdTotal: latest.apiAmountUsdTotal,
    expectedApiAmountUsd: latest.expectedApiAmountUsd,
    remainingExpectedApiAmountUsd: latest.remainingExpectedApiAmountUsd,
    consumedApiAmountUsd: consumedValue,
    apiAmountUsdPerHour: rate,
    burnWindowHours: elapsedHours,
    estimatedAvailableHours: latest.remainingExpectedApiAmountUsd !== null && latest.remainingExpectedApiAmountUsd <= 0
      ? 0
      : rate !== null && latest.remainingExpectedApiAmountUsd !== null
        ? latest.remainingExpectedApiAmountUsd / rate
        : null,
    accountCount: latest.accountCount,
    normalCount: latest.normalCount,
    rateLimitedCount: latest.rateLimitedCount,
    errorCount: latest.errorCount,
    warning: window.length < 2 || !hasRate
      ? "最近一小时有效样本不足，暂不可估算消耗"
      : consumed === 0
        ? "最近一小时有效区间内没有 API 消耗"
        : resetIntervals > 0
          ? `最近一小时发生 ${resetIntervals} 次号池基线变化，速率仅按稳定区间计算`
          : null,
  };
}

export function oauthRuntimeHistory(samples: OAuthRuntimeSample[], windowHours = 1, displayHours = 8) {
  const ordered = [...samples].sort((left, right) => Date.parse(left.sampledAt) - Date.parse(right.sampledAt));
  const history = ordered.map((sample, index) => {
    const previous = ordered[index - 1];
    const sampleElapsedHours = previous
      ? (Date.parse(sample.sampledAt) - Date.parse(previous.sampledAt)) / 3_600_000
      : 0;
    const sampleApiAmountUsdPerHour = previous && sampleElapsedHours > 0
      ? Math.max(0, sample.apiAmountUsdTotal - previous.apiAmountUsdTotal) / sampleElapsedHours
      : null;
    const cutoff = Date.parse(sample.sampledAt) - windowHours * 3_600_000;
    const prior = ordered.slice(0, index + 1).filter((row) => Date.parse(row.sampledAt) >= cutoff);
    const summary = summarizeOAuthRuntimeSamples(prior, windowHours);
    return {
      sampledAt: sample.sampledAt,
      apiAmountUsdTotal: sample.apiAmountUsdTotal,
      consumedApiAmountUsd: summary.consumedApiAmountUsd,
      apiAmountUsdPerHour: summary.apiAmountUsdPerHour,
      sampleApiAmountUsdPerHour,
      rollingApiAmountUsdPerHour: summary.apiAmountUsdPerHour,
      remainingExpectedApiAmountUsd: sample.remainingExpectedApiAmountUsd,
      estimatedAvailableHours: summary.estimatedAvailableHours,
    };
  });
  const latestAt = Date.parse(ordered.at(-1)?.sampledAt ?? "");
  if (!Number.isFinite(latestAt)) return [];
  const displayCutoff = latestAt - displayHours * 3_600_000;
  return history.filter((point) => Date.parse(point.sampledAt) >= displayCutoff);
}
