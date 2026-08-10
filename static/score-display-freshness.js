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

export function scoreFreshnessLabel(value, now = Date.now()) {
  const timestamp = Date.parse(value ?? '')
  if (!Number.isFinite(timestamp)) return '尚无成功快照'
  const totalSeconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const totalHours = Math.floor(totalMinutes / 60)
  const hours = totalHours % 24
  const days = Math.floor(totalHours / 24)
  if (days > 0) return `${days}天${hours}小时${minutes}分钟${seconds}秒前`
  if (hours > 0) return `${hours}小时${minutes}分钟${seconds}秒前`
  if (totalMinutes > 0) return `${totalMinutes}分钟${seconds}秒前`
  return `${seconds}秒前`
}
