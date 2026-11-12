export type ProbeCacheState = "hit" | "miss" | "unknown";
export type ProbeCacheMode = "full" | "compact";

export interface ProbeCacheAccountDetail {
  accountId: number | null;
  accountName: string | null;
  model: string | null;
  completedAt: string | null;
  cacheState: ProbeCacheState;
  cacheReadTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  rebilledInputTokens: number | null;
  cacheReadField: string | null;
  cacheMode: ProbeCacheMode | null;
  classification: string | null;
  qualityOk: boolean | null;
  httpStatus: number | null;
  ttftMs: number | null;
  durationMs: number | null;
  errorMarker: string | null;
}

export interface ProbeCacheSummary {
  requestCount: number;
  knownCount: number;
  hitCount: number;
  missCount: number;
  unknownCount: number;
  hitRate: number | null;
  cacheReadTokens: number | null;
  cacheReadKnownCount: number;
  rebilledInputTokens: number | null;
  rebilledKnownCount: number;
  compactPrefixCount: number;
  accounts: ProbeCacheAccountDetail[];
}

export interface ProbeCacheTriggerSummary {
  automatic: ProbeCacheSummary;
  manual: ProbeCacheSummary;
}

type Row = Record<string, unknown>;

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function positiveId(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function text(value: unknown, maximum = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : null;
}

function cacheState(evidence: Row): ProbeCacheState {
  if (evidence.cacheHit === true) return "hit";
  if (evidence.cacheHit === false) return "miss";
  const tokens = finiteNumber(evidence.cacheReadTokens);
  if (tokens === null) return "unknown";
  return tokens > 0 ? "hit" : "miss";
}

function rebilledTokens(evidence: Row, inputTokens: number | null, cacheReadTokens: number | null): number | null {
  if (inputTokens === null || cacheReadTokens === null) return null;
  const field = text(evidence.cacheReadField) ?? "";
  // Anthropic 风格字段把缓存读取与常规输入分开计数；其余兼容字段的
  // cached_tokens 是输入总量中的子集，需要从总量中扣除。
  if (field === "cache_read_input_tokens" || field === "cache_read_tokens") return inputTokens;
  return Math.max(0, inputTokens - cacheReadTokens);
}

export function emptyProbeCacheSummary(): ProbeCacheSummary {
  return {
    requestCount: 0,
    knownCount: 0,
    hitCount: 0,
    missCount: 0,
    unknownCount: 0,
    hitRate: null,
    cacheReadTokens: null,
    cacheReadKnownCount: 0,
    rebilledInputTokens: null,
    rebilledKnownCount: 0,
    compactPrefixCount: 0,
    accounts: [],
  };
}

export function projectProbeCacheAccount(evidenceValue: unknown): ProbeCacheAccountDetail {
  const evidence = row(evidenceValue);
  const inputTokens = finiteNumber(evidence.inputTokens);
  const cacheReadTokens = finiteNumber(evidence.cacheReadTokens);
  const httpStatus = finiteNumber(evidence.httpStatus);
  return {
    accountId: positiveId(evidence.accountId),
    accountName: text(evidence.accountName, 300),
    model: text(evidence.model, 200),
    completedAt: text(evidence.completedAt, 100),
    cacheState: cacheState(evidence),
    cacheReadTokens,
    inputTokens,
    outputTokens: finiteNumber(evidence.outputTokens),
    rebilledInputTokens: rebilledTokens(evidence, inputTokens, cacheReadTokens),
    cacheReadField: text(evidence.cacheReadField, 120),
    cacheMode: evidence.cacheMode === "compact" ? "compact" : evidence.cacheMode === "full" ? "full" : null,
    classification: text(evidence.classification, 80),
    qualityOk: typeof evidence.qualityOk === "boolean" ? evidence.qualityOk : null,
    httpStatus: httpStatus !== null && Number.isSafeInteger(httpStatus) ? httpStatus : null,
    ttftMs: finiteNumber(evidence.ttftMs),
    durationMs: finiteNumber(evidence.durationMs),
    errorMarker: text(evidence.errorMarker, 120),
  };
}

export function summarizeProbeCacheEvidence(evidenceValue: unknown, missingCount = 0): ProbeCacheSummary {
  const evidence = Array.isArray(evidenceValue) ? evidenceValue : [];
  const accounts = evidence.map(projectProbeCacheAccount);
  const known = accounts.filter((account) => account.cacheState !== "unknown");
  const missing = Number.isSafeInteger(missingCount) && missingCount > 0 ? missingCount : 0;
  const hitCount = known.filter((account) => account.cacheState === "hit").length;
  const missCount = known.length - hitCount;
  const cacheReadValues = accounts
    .map((account) => account.cacheReadTokens)
    .filter((value): value is number => value !== null);
  const rebilledValues = accounts
    .map((account) => account.rebilledInputTokens)
    .filter((value): value is number => value !== null);
  return {
    requestCount: accounts.length + missing,
    knownCount: known.length,
    hitCount,
    missCount,
    unknownCount: accounts.length - known.length + missing,
    hitRate: known.length > 0 ? hitCount / known.length : null,
    cacheReadTokens: cacheReadValues.length > 0 ? cacheReadValues.reduce((total, value) => total + value, 0) : null,
    cacheReadKnownCount: cacheReadValues.length,
    rebilledInputTokens: rebilledValues.length > 0 ? rebilledValues.reduce((total, value) => total + value, 0) : null,
    rebilledKnownCount: rebilledValues.length,
    compactPrefixCount: accounts.filter((account) => account.cacheMode === "compact").length,
    accounts,
  };
}

export function mergeProbeCacheSummaries(values: ProbeCacheSummary[]): ProbeCacheSummary {
  const summary = emptyProbeCacheSummary();
  for (const value of values) {
    summary.requestCount += value.requestCount;
    summary.knownCount += value.knownCount;
    summary.hitCount += value.hitCount;
    summary.missCount += value.missCount;
    summary.unknownCount += value.unknownCount;
    summary.cacheReadKnownCount += value.cacheReadKnownCount;
    summary.rebilledKnownCount += value.rebilledKnownCount;
    summary.compactPrefixCount += Number.isFinite(value.compactPrefixCount) ? value.compactPrefixCount : 0;
    if (value.cacheReadTokens !== null) summary.cacheReadTokens = (summary.cacheReadTokens ?? 0) + value.cacheReadTokens;
    if (value.rebilledInputTokens !== null) summary.rebilledInputTokens = (summary.rebilledInputTokens ?? 0) + value.rebilledInputTokens;
    summary.accounts.push(...value.accounts);
  }
  summary.hitRate = summary.knownCount > 0 ? summary.hitCount / summary.knownCount : null;
  return summary;
}

export function summarizeProbeCacheRecords(records: Array<Record<string, unknown>>): ProbeCacheTriggerSummary {
  const automatic: ProbeCacheSummary[] = [];
  const manual: ProbeCacheSummary[] = [];
  for (const record of records) {
    const summary = row(record.cache) as unknown as ProbeCacheSummary;
    const normalized = Array.isArray(summary.accounts)
      ? summary
      : summarizeProbeCacheEvidence(record.requestEvidence);
    if (record.triggerType === "automatic") automatic.push(normalized);
    if (record.triggerType === "manual") manual.push(normalized);
  }
  return {
    automatic: mergeProbeCacheSummaries(automatic),
    manual: mergeProbeCacheSummaries(manual),
  };
}
