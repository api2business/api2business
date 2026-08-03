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
  const first = window[0];
  const elapsedHours = first ? Math.max(0, (Date.parse(latest.sampledAt) - Date.parse(first.sampledAt)) / 3_600_000) : 0;
  const consumed = first && window.length >= 2
    ? Math.max(0, latest.apiAmountUsdTotal - first.apiAmountUsdTotal)
    : null;
  const rate = consumed !== null && consumed > 0 && elapsedHours > 0 ? consumed / elapsedHours : null;
  return {
    sampledAt: latest.sampledAt,
    apiAmountUsdTotal: latest.apiAmountUsdTotal,
    expectedApiAmountUsd: latest.expectedApiAmountUsd,
    remainingExpectedApiAmountUsd: latest.remainingExpectedApiAmountUsd,
    consumedApiAmountUsd: consumed,
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
    warning: window.length < 2
      ? "最近一小时有效样本不足，暂不可估算消耗"
      : rate === null ? "最近一小时没有可计算的 API 消耗" : null,
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
