export function scorePayloadTimestamp(payload) {
  for (const key of ['refreshedAt', 'queryCompletedAt', 'collectedAt']) {
    const value = payload?.[key]
    if (!value) continue
    const timestamp = Date.parse(value)
    if (Number.isFinite(timestamp)) return timestamp
  }
  return null
}

export function shouldApplyScorePayload(currentRefreshedAt, payload) {
  const currentTimestamp = currentRefreshedAt ? Date.parse(currentRefreshedAt) : Number.NaN
  if (!Number.isFinite(currentTimestamp)) return true
  const incomingTimestamp = scorePayloadTimestamp(payload)
  return incomingTimestamp !== null && incomingTimestamp >= currentTimestamp
}
