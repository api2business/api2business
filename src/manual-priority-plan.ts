export type ManualPriorityAssignments = Record<string, number>;

export function normalizeManualPriorityAssignments(value: unknown): ManualPriorityAssignments {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("manual priority plan requires an account-to-priority object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) throw new Error("manual priority plan requires at least one account");
  const normalized: Array<[string, number]> = [];
  const accountIds = new Set<number>();
  for (const [rawAccountId, rawPriority] of entries) {
    const accountId = Number(rawAccountId);
    const priority = Number(rawPriority);
    if (!Number.isSafeInteger(accountId) || accountId <= 0 || String(accountId) !== rawAccountId) {
      throw new Error(`invalid manual priority account ID: ${rawAccountId}`);
    }
    if (!Number.isSafeInteger(priority) || priority <= 0) {
      throw new Error(`invalid manual priority for account ${rawAccountId}`);
    }
    if (accountIds.has(accountId)) throw new Error(`duplicate manual priority account ID: ${accountId}`);
    accountIds.add(accountId);
    normalized.push([String(accountId), priority]);
  }
  normalized.sort(([left], [right]) => Number(left) - Number(right));
  return Object.fromEntries(normalized);
}
