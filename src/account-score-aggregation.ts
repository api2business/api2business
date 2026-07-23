type Row = Record<string, unknown>;

function record(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isFinite(parsed) ? parsed : null;
}

function sum(rows: Row[], key: string): number {
  return rows.reduce((total, row) => total + (numeric(row[key]) ?? 0), 0);
}

function sumPresent(rows: Row[], key: string): number | null {
  const values = rows.flatMap((row) => {
    const value = numeric(row[key]);
    return value === null ? [] : [value];
  });
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : null;
}

function max(rows: Row[], key: string): number | null {
  const values = rows.flatMap((row) => {
    const value = numeric(row[key]);
    return value === null ? [] : [value];
  });
  return values.length > 0 ? Math.max(...values) : null;
}

function accountKey(row: Row): string {
  if (row.accountId !== null && row.accountId !== undefined) return `id:${String(row.accountId)}`;
  return `name:${String(row.accountName ?? "").trim().toLowerCase()}`;
}

function reliabilityPoints(failureRate: number | null): number | null {
  return failureRate === null ? null : Math.round(60 * (1 - Math.min(Math.max(failureRate, 0), 0.2) / 0.2) * 100) / 100;
}

function latencyPoints(ttftP95Ms: number | null): number | null {
  return ttftP95Ms === null ? null : Math.round(25 * (1 - Math.min(Math.max(ttftP95Ms - 10_000, 0), 170_000) / 170_000) * 100) / 100;
}

function scoreGrade(score: number | null, comparable: boolean, observedAttempts: number): string {
  if (score === null || (!comparable && !(score < 60 && observedAttempts >= 10))) return "insufficient";
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "E";
}

function assessment(grade: string): string {
  return ({ A: "preferred", B: "healthy", C: "watch", D: "degraded", E: "poor" } as Record<string, string>)[grade] ?? "insufficient-evidence";
}

export function mergeAccountScores(rows: Row[]): Row[] {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) grouped.set(accountKey(row), [...(grouped.get(accountKey(row)) ?? []), row]);

  return [...grouped.values()].map((accountRows) => {
    const representative = accountRows[0]!;
    const groupIds = [...new Set(accountRows.flatMap((row) => Array.isArray(row.groupIds) ? row.groupIds : [row.groupId]).filter((value) => value !== null && value !== undefined))];
    const groupNames = [...new Set(accountRows.flatMap((row) => Array.isArray(row.groupNames) ? row.groupNames.map(String) : [String(row.groupName ?? "")]).map((value) => value.trim()).filter(Boolean))];
    const usages = accountRows.map((row) => record(row.usage) ?? {});
    const successRequests = sum(accountRows, "successRequests");
    const failureRequests = sum(accountRows, "failureRequests");
    const observedAttempts = successRequests + failureRequests;
    const failureRate = observedAttempts > 0 ? Math.round(failureRequests / observedAttempts * 1_000_000) / 1_000_000 : null;
    const firstTokenSamples = sum(accountRows, "firstTokenSamples");
    const streamSuccessRequests = sum(accountRows, "streamSuccessRequests");
    const ttftP95Ms = max(accountRows, "ttftP95Ms");
    const reliability = reliabilityPoints(failureRate);
    const latency = firstTokenSamples >= 5 ? latencyPoints(ttftP95Ms) : null;
    const currentlyAvailable = accountRows.every((row) => row.currentlyAvailable === true);
    const status = String(representative.status ?? "");
    const availability = currentlyAvailable ? 15 : status === "active" ? 8 : 0;
    const availableWeight = (reliability === null ? 0 : 60) + (latency === null ? 0 : 25) + 15;
    const earned = (reliability ?? 0) + (latency ?? 0) + availability;
    const score = observedAttempts > 0 && availableWeight > 0 ? Math.round(earned / availableWeight * 1_000) / 10 : null;
    const comparable = observedAttempts >= 10 && firstTokenSamples >= 5;
    const grade = scoreGrade(score, comparable, observedAttempts);
    const reasons = [...new Set(accountRows.flatMap((row) => Array.isArray(row.reasons) ? row.reasons.map(String) : []))];

    return {
      ...representative,
      groupId: groupIds.length === 1 ? groupIds[0] : null,
      groupName: groupNames.join(" / "),
      groupIds,
      groupNames,
      currentlyAvailable,
      score,
      grade,
      assessment: assessment(grade),
      confidence: observedAttempts >= 50 && firstTokenSamples >= 20 ? "high" : observedAttempts >= 10 && firstTokenSamples >= 5 ? "medium" : "low",
      scoreComparable: comparable,
      observedAttempts,
      successRequests,
      failureRequests,
      failureRate,
      streamSuccessRequests,
      firstTokenSamples,
      firstTokenCoverage: streamSuccessRequests > 0 ? Math.round(firstTokenSamples / streamSuccessRequests * 1_000_000) / 1_000_000 : null,
      ttftP95Ms,
      customerErrorRequests: sum(accountRows, "customerErrorRequests"),
      scoreableUpstreamErrorRequests: sum(accountRows, "scoreableUpstreamErrorRequests"),
      excludedNonUpstreamErrorRequests: sum(accountRows, "excludedNonUpstreamErrorRequests"),
      failoverRequests: sum(accountRows, "failoverRequests"),
      failoverRecovered: sum(accountRows, "failoverRecovered"),
      failoverFailed: sum(accountRows, "failoverFailed"),
      failoverOutcomeMissing: sum(accountRows, "failoverOutcomeMissing"),
      sameAccountRetryEvents: sum(accountRows, "sameAccountRetryEvents"),
      tempUnschedulableEvents: sum(accountRows, "tempUnschedulableEvents"),
      forwardFailedRequests: sum(accountRows, "forwardFailedRequests"),
      reasons,
      usage: {
        ...usages[0],
        requestCount: sumPresent(usages, "requestCount"),
        tokenCount: sumPresent(usages, "tokenCount"),
        apiAmountUsd: (() => {
          const value = sumPresent(usages, "apiAmountUsd");
          return value === null ? null : Math.round(value * 100_000_000) / 100_000_000;
        })(),
        upstreamCostCny: (() => {
          const value = sumPresent(usages, "upstreamCostCny");
          return value === null ? null : Math.round(value * 100_000_000) / 100_000_000;
        })(),
      },
      scoreComponents: { reliability, latency, availability, availableWeight },
      aggregation: {
        scope: "unique-account-across-groups",
        groupCount: groupNames.length,
        latency: "maximum-group-ttft-p95",
      },
    };
  }).sort((left, right) => Number(right.score ?? -1) - Number(left.score ?? -1));
}
