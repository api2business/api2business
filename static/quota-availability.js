export function quotaAccountAvailable(state, now = Date.now()) {
  if (!state || state.status !== 'active' || state.schedulable !== true) return false
  for (const key of ['tempUnschedulableUntil', 'rateLimitResetAt', 'overloadUntil']) {
    if (state[key] && Date.parse(state[key]) > now) return false
  }
  if (state.autoPauseOnExpired && state.expiresAt && Date.parse(state.expiresAt) <= now) return false
  return true
}

export function quotaAvailabilityTotals(rows, group) {
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.remaining ?? 0), 0)
  const available = rows.filter((row) => row.availableGroups?.includes(group))
    .reduce((sum, row) => sum + Math.max(0, row.remaining ?? 0), 0)
  return { total, available, unavailable: total - available, ratio: total > 0 ? available / total : 0 }
}
