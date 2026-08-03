export function sampleTimeDisplay(value, now = Date.now()) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return { label: '无样本', exact: '', freshness: 'missing' }
  const ageSeconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  const exact = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(timestamp))
  if (ageSeconds < 60) return { label: '刚刚', exact, freshness: 'fresh' }
  if (ageSeconds < 3600) return { label: `${Math.floor(ageSeconds / 60)} 分钟前`, exact, freshness: 'recent' }
  if (ageSeconds < 86400) return { label: `${Math.floor(ageSeconds / 3600)} 小时前`, exact, freshness: 'aging' }
  return {
    label: new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(timestamp)),
    exact,
    freshness: 'old',
  }
}
