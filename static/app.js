import { shouldApplyScorePayload } from './score-display-freshness.js'
import { sampleTimeDisplay } from './sample-time.js'

const page = document.body.dataset.page
const $ = (selector) => document.querySelector(selector)

function escapeHtml(value) {
  const node = document.createElement('span')
  node.textContent = String(value ?? '')
  return node.innerHTML
}

function number(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}
function duration(value) { return Number.isFinite(Number(value)) ? `${number(Number(value) / 1000, 1)}s` : '—' }

function usd(value, digits = 3) {
  const numeric = Number(value)
  if (value === null || value === undefined || !Number.isFinite(numeric)) return '<span class="usd-value is-empty">—</span>'
  const formatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits })
  const parts = formatter.formatToParts(numeric)
  const whole = parts.filter(({ type }) => ['minusSign', 'plusSign', 'integer', 'group'].includes(type)).map(({ value: part }) => part).join('')
  const point = parts.find(({ type }) => type === 'decimal')?.value ?? '.'
  const fraction = parts.find(({ type }) => type === 'fraction')?.value ?? ''.padEnd(digits, '0')
  const label = `$${formatter.format(numeric)}`
  return `<span class="usd-value" aria-label="${escapeHtml(label)}"><span class="usd-symbol" aria-hidden="true">$</span><span class="usd-whole" aria-hidden="true">${escapeHtml(whole)}</span><span class="usd-point" aria-hidden="true">${escapeHtml(point)}</span><span class="usd-fraction" aria-hidden="true">${escapeHtml(fraction)}</span></span>`
}

function compact(value) {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(Number(value))
}

function percent(value) {
  return value === null || value === undefined ? '—' : `${number(Number(value) * 100, 1)}%`
}

function time(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value))
}

async function requestJson(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
    const data = await response.json().catch(() => null)
    if (response.status === 401 && page !== 'login') {
      location.assign('/login')
      throw new Error('登录状态已失效')
    }
    if (!response.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
    return data
  } finally {
    clearTimeout(timer)
  }
}

function shell() {
  const mount = $('[data-shell]')
  if (!mount) return
  const links = [
    ['scores', '/scores', '上游资产与成本'],
    ['ranking', '/ranking', '用户用量'],
    ['lottery', '/lottery', '额度抽奖'],
    ['operations', '/operations', '经营管理'],
    ['oauth-cost', '/oauth-cost', 'OAuth 实时成本'],
    ['account-import', '/account-import', '账号导入'],
  ]
  mount.innerHTML = `<header class="topbar">
    <a class="brand" href="/scores"><span class="brand-mark">AS</span><span><b>Api2Business</b><small>Sub2API Operations</small></span></a>
    <nav class="primary-nav" aria-label="主导航">${links.map(([id, href, label]) => `<a href="${href}"${page === id ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <div class="topbar-actions"><span class="live-sign"><i></i> PK01</span><button id="logout" class="text-command" type="button">退出</button></div>
  </header>`
  const primaryNav = mount.querySelector('.primary-nav')
  const activeLink = primaryNav?.querySelector('a[aria-current="page"]')
  if (primaryNav && activeLink && primaryNav.scrollWidth > primaryNav.clientWidth) {
    requestAnimationFrame(() => activeLink.scrollIntoView({ block: 'nearest', inline: 'center' }))
  }
  $('#logout').addEventListener('click', async () => {
    await requestJson('/api/logout', { method: 'POST', body: '{}' }).catch(() => null)
    location.assign('/login')
  })
}

async function loginPage() {
  const form = $('#login-form')
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const button = form.querySelector('button')
    const error = $('#login-error')
    button.disabled = true
    error.textContent = ''
    try {
      await requestJson('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: $('#username').value, password: $('#password').value }),
      })
      location.assign('/scores')
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause)
    } finally {
      button.disabled = false
    }
  })
}

let scoreRows = []
let scoreUpstreamsById = new Map()
let scoreUsageById = new Map()
let scoreBenchmarksById = new Map()
let scoreBenchmarkOptions = null
let scoreSort = { key: 'score', direction: 'desc' }
let scoreRefreshedAt = null
let scoreNextRefreshAt = null
let priorityPlanRows = new Map()
let priorityPlanVisible = false
let activeScoreProfile = 'codex'
let scorePage = 1
const scorePageSize = 10
const scoreRefreshIntervals = new Set([0, 300, 900, 1800])
const scoreRefreshIntervalStorageKey = 'api2business.scoreRefreshIntervalSeconds'
let scoreRefreshTimer = null
let scoreRefreshCountdownTimer = null
let scoreRefreshDueAt = null
let scoreRefreshInFlight = null
let upstreamAssetsInFlight = null
let quotaSummaryInFlight = null
let poolQualityInFlight = null

function scoreProfile(row) {
  return String(row.platform ?? '').toLowerCase() === 'grok' ? 'grok' : 'codex'
}

function scoreRowsForActiveProfile() {
  return scoreRows.filter((row) => scoreProfile(row) === activeScoreProfile)
}

function gradeClass(value) {
  const grade = String(value ?? '').toLowerCase()
  if (grade === 'a' || grade === 'b' || grade === 'excellent' || grade === 'good') return 'grade-good'
  if (grade === 'd' || grade === 'e' || grade === 'poor' || grade === 'critical' || grade === 'insufficient') return 'grade-risk'
  return 'grade-mid'
}

function groupLabels(row) {
  const groups = Array.isArray(row.groupNames) && row.groupNames.length ? row.groupNames : [row.groupName].filter(Boolean)
  return `<div class="group-list">${groups.map((group) => `<span>${escapeHtml(group)}</span>`).join('')}</div>`
}

function countdown(value) {
  if (!value) return '--:--'
  const remaining = Math.max(0, new Date(value).getTime() - Date.now())
  if (remaining === 0) return '等待刷新'
  const totalSeconds = Math.ceil(remaining / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function renderRefreshClock() {
  $('#score-updated-time').textContent = scoreRefreshedAt ? `北京时间 ${time(scoreRefreshedAt)}` : '尚无成功快照'
  renderScoreRefreshCountdown()
}

function renderScoreRefreshCountdown() {
  const target = $('#score-refresh-countdown')
  if (!target) return
  const interval = Number($('#score-refresh-interval')?.value)
  if (!scoreRefreshIntervals.has(interval) || interval <= 0) {
    target.textContent = '自动刷新已关闭'
    return
  }
  if (scoreRefreshDueAt === null) {
    target.textContent = '下次刷新 --:--'
    return
  }
  target.textContent = `距离下次更新 ${countdown(scoreRefreshDueAt)}`
}

function clearScoreRefreshTimer() {
  if (scoreRefreshTimer !== null) clearTimeout(scoreRefreshTimer)
  if (scoreRefreshCountdownTimer !== null) clearInterval(scoreRefreshCountdownTimer)
  scoreRefreshTimer = null
  scoreRefreshCountdownTimer = null
  scoreRefreshDueAt = null
  renderScoreRefreshCountdown()
}

function scheduleScoreRefresh() {
  clearScoreRefreshTimer()
  const interval = Number($('#score-refresh-interval')?.value)
  if (!scoreRefreshIntervals.has(interval) || interval <= 0) return
  scoreRefreshDueAt = Date.now() + interval * 1000
  renderScoreRefreshCountdown()
  scoreRefreshCountdownTimer = setInterval(renderScoreRefreshCountdown, 1000)
  scoreRefreshTimer = setTimeout(async () => {
    scoreRefreshDueAt = null
    renderScoreRefreshCountdown()
    await Promise.allSettled([
      refreshPriorityState(),
      loadUnifiedUpstreamAssets(),
      loadUnifiedQuotaSummary(),
      loadPoolQuality(),
      loadPriorityHistory(),
      loadIdleProbeHistory(),
    ])
    scheduleScoreRefresh()
  }, interval * 1000)
}

function readScoreRefreshInterval() {
  try {
    const value = Number(localStorage.getItem(scoreRefreshIntervalStorageKey))
    return scoreRefreshIntervals.has(value) ? value : 0
  } catch { return 0 }
}

function writeScoreRefreshInterval(value) {
  try { localStorage.setItem(scoreRefreshIntervalStorageKey, String(value)) } catch { /* 当前页面仍按选择运行。 */ }
}

function scoreAsset(row) {
  const upstream = scoreUpstreamsById.get(Number(row.accountId)) ?? null
  const usageResult = scoreUsageById.get(Number(row.accountId)) ?? null
  const quota = usageResult?.quota ?? {}
  const remainingUsd = quota.unit === 'USD' && quota.remaining != null ? Number(quota.remaining) : null
  const walletRate = upstream ? upstreamWalletCnyRate(upstream.baseUrl) : 1
  const balanceCny = remainingUsd !== null && Number.isFinite(remainingUsd) ? Math.max(0, remainingUsd) * walletRate : null
  const probe = usageResult?.billingMultiplier ?? {}
  const probeCost = probe.value != null && Number.isFinite(Number(probe.value)) && Number(probe.value) > 0
    ? Number(probe.value) * walletRate
    : null
  return { upstream, usageResult, balanceCny, probeCost }
}

function scoreSortValue(row, key) {
  const { upstream, balanceCny, probeCost } = scoreAsset(row)
  const usage = row.usage ?? {}
  const values = {
    accountName: String(row.accountName ?? '').toLowerCase(),
    available: (row.currentAvailable ?? row.currentlyAvailable) ? 1 : 0,
    score: Number(row.score),
    priority: Number(row.priority),
    balance: balanceCny,
    rate: upstream?.rateCnyPerApiUsd ?? usage.costRateCnyPerApiUsd,
    probeCost,
    apiAmountUsd: Number(usage.apiAmountUsd),
    latestSampleAt: row.latestSampleAt ? Date.parse(row.latestSampleAt) : null,
    failureRate: Number(row.failureRate),
    ttftP95Ms: Number(row.ttftP95Ms),
  }
  return values[key]
}

function compareScoreRows(left, right) {
  const a = scoreSortValue(left, scoreSort.key)
  const b = scoreSortValue(right, scoreSort.key)
  const missingA = a == null || (typeof a === 'number' && !Number.isFinite(a))
  const missingB = b == null || (typeof b === 'number' && !Number.isFinite(b))
  if (missingA !== missingB) return missingA ? 1 : -1
  const result = typeof a === 'string' ? a.localeCompare(String(b), 'zh-CN') : Number(a) - Number(b)
  return (scoreSort.direction === 'asc' ? result : -result) || Number(left.accountId) - Number(right.accountId)
}

async function loadIdleProbeRollingUsage() {
  const data = await requestJson('/api/operations/idle-probe/summary')
  const rolling = data.rolling24Hours ?? {}
  $('#idle-probe-rolling').textContent = `探活 24h：${number(rolling.requestAttempts)} 次 · ${usdText(rolling.consumedApiAmountUsd, 4)} · ${number(rolling.sampledAccounts)} 个账号${rolling.latestSampleAt ? ` · 最近 ${time(rolling.latestSampleAt)}` : ''}`
  return rolling
}

function renderScoreRows() {
  const term = ($('#score-filter')?.value ?? '').trim().toLowerCase()
  const filteredRows = scoreRowsForActiveProfile()
    .filter((row) => {
      const upstream = scoreUpstreamsById.get(Number(row.accountId))
      return `${row.accountName ?? ''} ${upstream?.baseUrl ?? ''} ${upstream?.status ?? ''} ${row.groupName ?? ''} ${(row.groupNames ?? []).join(' ')}`.toLowerCase().includes(term)
    })
    .sort(compareScoreRows)
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / scorePageSize))
  scorePage = Math.min(Math.max(scorePage, 1), totalPages)
  const start = (scorePage - 1) * scorePageSize
  const rows = filteredRows.slice(start, start + scorePageSize)
  $('#score-body').innerHTML = rows.length ? rows.map((row) => {
    const usage = row.usage ?? {}
    const planRow = priorityPlanRows.get(String(row.accountId))
    const desiredPriority = priorityPlanVisible && planRow ? Number(planRow.desiredPriority) : null
    const priorityDelta = desiredPriority === null ? null : desiredPriority - Number(row.priority)
    const costRate = planRow?.costRateCnyPerApiUsd ?? usage.costRateCnyPerApiUsd
    const available = row.currentAvailable ?? row.currentlyAvailable
    const reason = row.availabilityReason ?? {}
    const reasonDetail = reason.resetAt ? `${reason.detail ?? reason.label}，${time(reason.resetAt)} 恢复` : (reason.detail ?? reason.label ?? '原因未记录')
    const { upstream, usageResult, balanceCny, probeCost } = scoreAsset(row)
    const desiredLabel = desiredPriority === null ? number(row.priority) : `${number(row.priority)} → ${number(desiredPriority)}`
    const status = upstream ? upstreamStatus(upstream) : { label: available ? '可调度' : '不可用', className: available ? 'is-available' : 'is-error' }
    const latestSample = sampleTimeDisplay(row.latestSampleAt)
    return `<tr class="${available ? '' : 'score-row-unavailable'}">
      <td class="account-cell"><b>${escapeHtml(row.accountName)}</b><small>#${escapeHtml(row.accountId)}${upstream?.baseUrl ? ` · ${escapeHtml(upstream.baseUrl)}` : ''}</small></td>
      <td><span class="upstream-status ${status.className}">${status.label}</span><small class="upstream-muted">${escapeHtml(reason.label ?? upstream?.status ?? '—')}</small></td>
      <td><span class="score-value ${gradeClass(row.grade)}">${number(row.score, 1)}</span><small class="upstream-muted">${escapeHtml(row.grade ?? '—')} · ${escapeHtml(row.confidence ?? '—')}</small></td>
      <td>${desiredLabel}<small class="upstream-muted">${priorityDelta === null ? '当前' : `变化 ${signed(priorityDelta)}`}</small></td>
      <td class="upstream-balance" data-known="${balanceCny !== null}"><strong>${balanceCny === null ? '未查询' : cny(balanceCny)}</strong><small>${usageResult?.queriedAt ? time(usageResult.queriedAt) : '无额度样本'}</small></td>
      <td class="upstream-rate">${upstream?.rateCnyPerApiUsd == null ? costRate == null ? '—' : `¥${number(costRate, 4)}` : `¥${number(upstream.rateCnyPerApiUsd, 4)}`}</td>
      <td class="upstream-multiplier"><strong>${probeCost === null ? '未知' : `¥${number(probeCost, 4)}`}</strong><small>${escapeHtml(usageResult?.billingMultiplier?.source ?? '无探测')}</small></td>
      <td class="usd-cell">${usd(usage.apiAmountUsd)}<small class="upstream-muted">${compact(usage.requestCount)} 请求</small></td>
      <td class="sample-time sample-time-${latestSample.freshness}"${latestSample.exact ? ` title="北京时间 ${escapeHtml(latestSample.exact)}"` : ''}><span>${escapeHtml(latestSample.label)}</span></td>
      <td>${percent(row.failureRate)}<small class="upstream-muted">${number(row.observedAttempts)} 次尝试</small></td>
      <td>${row.ttftP95Ms == null ? '—' : `${number(row.ttftP95Ms)} ms`}</td>
      <td class="failover-cell" title="失败 ${number(row.failureRequests)} 次；触发切号 ${number(row.failoverRequests)} 次，其中恢复 ${number(row.failoverRecovered)} 次；未触发切号 ${number(row.failoverNotTriggered)} 次">
        <span>${number(row.failureRequests)} / ${number(row.failoverRequests)} / ${number(row.failoverRecovered)}</span>
        <small>未触发 ${number(row.failoverNotTriggered)}</small>
      </td>
      <td>${groupLabels(row)}</td>
      <td>${upstream ? `<div class="table-row-actions"><button class="icon-command benchmark-trigger${scoreBenchmarksById.get(Number(row.accountId))?.state === 'running' ? ' is-running' : ''}" type="button" data-score-benchmark="${escapeHtml(row.accountId)}" title="智商评测" aria-label="智商评测"><span>⌁</span></button><button class="text-command table-action" type="button" data-score-upstream-edit="${escapeHtml(row.accountId)}">调整</button></div>${scoreBenchmarksById.has(Number(row.accountId)) ? `<small class="benchmark-inline">${scoreBenchmarksById.get(Number(row.accountId)).state === 'running' ? '评测中' : `智商 ${scoreBenchmarksById.get(Number(row.accountId)).score == null ? '—' : number(scoreBenchmarksById.get(Number(row.accountId)).score, 1)}`} · ${escapeHtml(scoreBenchmarksById.get(Number(row.accountId)).state)}</small>` : ''}` : '—'}</td>
    </tr>`
  }).join('') : '<tr><td colspan="14" class="empty">没有匹配的账号</td></tr>'
  const range = filteredRows.length === 0 ? '0 条' : `${start + 1}-${Math.min(start + scorePageSize, filteredRows.length)} / ${number(filteredRows.length)} 条`
  $('#score-page').textContent = `${scorePage} / ${totalPages} · ${range}`
  $('#score-prev').disabled = scorePage <= 1
  $('#score-next').disabled = scorePage >= totalPages
  document.querySelectorAll('[data-score-sort]').forEach((header) => {
    const selected = header.dataset.scoreSort === scoreSort.key
    header.setAttribute('aria-sort', selected ? (scoreSort.direction === 'asc' ? 'ascending' : 'descending') : 'none')
  })
}

function renderScoreMetrics(data = {}) {
  const rows = scoreRowsForActiveProfile()
  const groups = [...new Set(rows.flatMap((row) =>
    Array.isArray(row.groupNames) ? row.groupNames : [row.groupName].filter(Boolean)
  ))]
  const values = {
    'metric-accounts': number(rows.length),
    'metric-groups': number(groups.length),
    'metric-good': number(rows.filter((row) => Number(row.score) >= 80).length),
    'metric-risk': number(rows.filter((row) => Number(row.score) < 60).length),
    'metric-window': data.window ?? (data.recentCallLimit ? `最近 ${number(data.recentCallLimit)} 次` : null),
  }
  for (const [id, value] of Object.entries(values)) {
    const target = document.getElementById(id)
    if (target && value !== null) target.textContent = value
  }
}

function renderScores(data) {
  if (!shouldApplyScorePayload(scoreRefreshedAt, data)) return false
  scoreRows = data.accounts ?? []
  renderScoreMetrics(data)
  const status = data.status ?? (scoreRows.length ? 'ready' : 'unavailable')
  $('#score-state').textContent = ({ ready: '已更新', refreshing: '刷新中', stale: '使用旧快照', unavailable: '暂无快照' })[status] ?? status
  $('#score-state').dataset.state = status
  scoreRefreshedAt = data.refreshedAt ?? data.queryCompletedAt ?? data.collectedAt ?? scoreRefreshedAt
  scoreNextRefreshAt = data.nextRefreshAt ?? scoreNextRefreshAt
  if (data.recentCallLimit && $('#score-call-limit')) $('#score-call-limit').value = String(data.recentCallLimit)
  renderRefreshClock()
  renderScoreRows()
  return true
}

async function loadUnifiedUpstreamAssets() {
  if (upstreamAssetsInFlight !== null) return await upstreamAssetsInFlight
  upstreamAssetsInFlight = (async () => {
    const [first, options, benchmarks] = await Promise.all([
      requestJson('/api/upstreams?page=1'),
      requestJson('/api/upstreams/options'),
      requestJson('/api/upstreams/benchmarks'),
    ])
    upstreamValuationPolicy = options.valuation ?? upstreamValuationPolicy
    scoreBenchmarkOptions = options.benchmark ?? scoreBenchmarkOptions
    scoreBenchmarksById = new Map((benchmarks.results ?? []).map((row) => [Number(row.accountId), row]))
    const pageCount = Math.max(1, Number(first.totalPages ?? 1))
    const rest = pageCount > 1
      ? await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) => requestJson(`/api/upstreams?page=${index + 2}`)))
      : []
    const accounts = [first, ...rest].flatMap((pageData) => pageData.accounts ?? [])
    scoreUpstreamsById = new Map(accounts.map((row) => [Number(row.id), row]))
    const ids = accounts.map((row) => Number(row.id)).filter(Number.isSafeInteger)
    const batches = []
    for (let offset = 0; offset < ids.length; offset += 40) batches.push(ids.slice(offset, offset + 40))
    const cachedPages = await Promise.all(batches.map((batch) => requestJson(`/api/upstreams/usage-cache?accountIds=${batch.join(',')}`)))
    scoreUsageById = new Map(cachedPages.flatMap((cached) => cached.results ?? []).map((result) => [Number(result.accountId), result]))
    renderScoreRows()
  })()
  try { return await upstreamAssetsInFlight } finally { upstreamAssetsInFlight = null }
}

async function loadUnifiedQuotaSummary() {
  if (quotaSummaryInFlight !== null) return await quotaSummaryInFlight
  quotaSummaryInFlight = requestJson('/api/upstreams/quota-summary').then(renderUnifiedQuotaSummary)
  try { return await quotaSummaryInFlight } finally { quotaSummaryInFlight = null }
}

function renderUnifiedQuotaSummary(summary) {
  const points = Array.isArray(summary.history) ? summary.history : []
  const total = Number(summary.totalRemainingCny)
  const schedulable = Number(summary.schedulableRemainingCny)
  const known = summary.totalRemainingCny != null && Number.isFinite(total)
  $('#quota-total').textContent = known ? cny(total) : '—'
  $('#quota-schedulable').textContent = summary.schedulableRemainingCny == null ? '—' : cny(schedulable)
  $('#quota-consumed').textContent = summary.consumedCny == null ? '暂不可计算' : cny(summary.consumedCny)
  $('#quota-output').textContent = summary.apiAmountUsd == null ? '暂不可计算' : usdText(summary.apiAmountUsd, 3)
  const rollingCost = finiteChartValue(summary.realtimeCostCnyPerApiUsd)
  $('#quota-realtime-cost').textContent = rollingCost === null ? '暂不可计算' : `¥${number(rollingCost, 4)}/刀`
  const hours = summary.estimatedAvailableHours == null ? null : Number(summary.estimatedAvailableHours)
  $('#quota-estimated-hours').textContent = hours !== null && Number.isFinite(hours) ? (hours >= 24 ? `${number(hours / 24, 1)} 天` : `${number(hours, 1)} 小时`) : '暂不可估算'
  const latestPoint = points.at(-1) ?? {}
  const sampleSpeed = finiteChartValue(latestPoint.sampleApiAmountUsdPerHour)
  const rollingSpeed = finiteChartValue(latestPoint.rollingApiAmountUsdPerHour)
  const sampleCost = finiteChartValue(summary.sampleRealtimeCostCnyPerApiUsd)
  $('#quota-sample-speed').textContent = sampleSpeed === null ? '暂不可计算' : usdText(sampleSpeed, 2)
  $('#quota-rolling-speed').textContent = rollingSpeed === null ? '暂不可计算' : usdText(rollingSpeed, 2)
  $('#quota-sample-cost').textContent = sampleCost === null ? '暂不可计算' : `¥${number(sampleCost, 4)}/刀`
  const walletDistribution = Array.isArray(summary.walletDistribution) ? summary.walletDistribution : []
  renderDonut({
    ring: $('#quota-ring'), detail: $('#quota-ring-detail'), items: walletDistribution,
    center: known ? cny(total) : '—', centerLabel: '总余额', emptyDetail: '暂无可用余额明细',
    itemLabel: (item) => item.wallet,
    itemDetail: (item) => `${percent(item.ratio)} · ${cny(item.remainingCny)}${item.remainingUsd == null ? '' : ` · $${number(item.remainingUsd, 2)}`}${item.schedulable ? '' : ' · 不可调度'}`,
  })
  $('#quota-monitor-state').textContent = `${summary.sampledAt ? time(summary.sampledAt) : '尚无采样'} · ${number(summary.knownWallets)} 个已知 wallet${summary.warning ? ` · ${summary.warning}` : ''}`
  $('#quota-balance-chart').innerHTML = historyChartMarkup(points, {
    series: [
      { key: 'sampleApiAmountUsdPerHour', className: 'chart-sample-speed', label: '当前采样' },
      { key: 'rollingApiAmountUsdPerHour', className: 'chart-rolling-speed', label: '一小时滚动' },
    ],
    valueFormatter: (value) => usdText(value, value < 10 ? 2 : 1), unit: 'API 美元 / 小时', ariaLabel: '上游 API 消耗速率',
  })
  $('#quota-cost-chart').innerHTML = historyChartMarkup(points, {
    series: [
      { key: 'sampleRealtimeCostCnyPerApiUsd', className: 'chart-cost', label: '当前采样' },
      { key: 'realtimeCostCnyPerApiUsd', className: 'chart-rolling-cost', label: '一小时滚动' },
    ],
    valueFormatter: (value) => `¥${number(value, 4)}`, unit: '人民币 / API 美元', ariaLabel: '上游实时成本', yMax: 0.3,
  })
  bindHistoryChartTooltip($('#quota-balance-chart'))
  bindHistoryChartTooltip($('#quota-cost-chart'))
}

const poolParticipationColors = ['#afdd4a', '#78b8de', '#d6a94d', '#d77b70', '#9ba7d7', '#74c7a1', '#d49ad2', '#b6a37c']

function renderDonut({ ring, detail, items, center, centerLabel, emptyDetail, itemLabel, itemDetail }) {
  const normalized = items.filter((item) => Number(item.ratio) > 0)
  let angle = 0
  const stops = normalized.map((item, index) => {
    const start = angle
    angle += Number(item.ratio) * 360
    return `${poolParticipationColors[index % poolParticipationColors.length]} ${start}deg ${angle}deg`
  })
  ring.style.background = stops.length ? `radial-gradient(circle, var(--surface) 0 56%, transparent 57%), conic-gradient(${stops.join(',')})` : ''
  ring.innerHTML = `<strong>${center}</strong><small>${centerLabel}</small>`
  detail.textContent = ''
  detail.style.display = 'none'
  const hideDetail = () => { detail.style.display = 'none' }
  const showDetail = (event, text) => {
    detail.textContent = text
    detail.style.display = 'block'
    const parent = detail.parentElement
    const parentBounds = parent.getBoundingClientRect()
    const bounds = detail.getBoundingClientRect()
    const left = Math.max(6, Math.min(event.clientX - parentBounds.left + 12, parentBounds.width - bounds.width - 6))
    const top = Math.max(6, Math.min(event.clientY - parentBounds.top + 12, parentBounds.height - bounds.height - 6))
    detail.style.left = `${left}px`
    detail.style.top = `${top}px`
  }
  ring.onpointermove = (event) => {
    const bounds = ring.getBoundingClientRect()
    const x = event.clientX - bounds.left - bounds.width / 2
    const y = event.clientY - bounds.top - bounds.height / 2
    const distance = Math.hypot(x, y)
    if (distance < bounds.width * .28 || distance > bounds.width * .52) { hideDetail(); return }
    const ratio = ((Math.atan2(x, -y) * 180 / Math.PI + 360) % 360) / 360
    let cursor = 0
    const item = normalized.find((candidate) => {
      cursor += Number(candidate.ratio)
      return ratio <= cursor
    }) ?? normalized.at(-1)
    if (item) showDetail(event, `${itemLabel(item)}\n${itemDetail(item)}`)
  }
  ring.onpointerleave = hideDetail
}

function renderPoolQuality(data) {
  const score = data.score == null ? null : Number(data.score)
  const grade = String(data.grade ?? 'insufficient')
  document.querySelector('.pool-quality-score').dataset.grade = grade
  $('#pool-quality-score').textContent = score === null ? '—' : number(score, 1)
  $('#pool-quality-grade').textContent = grade === 'insufficient' ? '证据不足' : `${grade} 级`
  $('#pool-quality-state').textContent = data.sampledAt
    ? `${time(data.sampledAt)} 采样 · 最近 ${number(data.recentCallLimit)} 次 · 混池 #2 + 自用 #3`
    : '尚无质量采样，等待下一轮五分钟任务'
  $('#pool-quality-outcomes').textContent = `${number(data.successRequests)} / ${number(data.failureRequests)}`
  $('#pool-quality-failure-rate').textContent = `失败率 ${data.failureRate == null ? '—' : percent(data.failureRate)}`
  $('#pool-quality-failover').textContent = `${number(data.failoverRecovered)} / ${number(data.failoverRequests)}`
  $('#pool-quality-ttft').textContent = data.ttftP95Ms == null ? '—' : `${number(data.ttftP95Ms)} ms`
  $('#pool-quality-ttft-samples').textContent = `首 token 样本 ${number(data.firstTokenSamples)}`
  $('#pool-quality-chart').innerHTML = historyChartMarkup(data.history ?? [], {
    series: [
      { key: 'score', className: 'chart-pool-quality', label: '当前采样' },
      { key: 'rollingScore', className: 'chart-pool-quality-rolling', label: '一小时滚动' },
    ],
    valueFormatter: (value) => number(value, 1), unit: '质量分 / 100', ariaLabel: '混池和自用池综合质量评分', yMin: 0, yMax: 100,
  })
  bindHistoryChartTooltip($('#pool-quality-chart'))
  const participation = Array.isArray(data.participation) ? data.participation : []
  const ring = $('#pool-participation-ring')
  renderDonut({
    ring, detail: $('#pool-participation-detail'), items: participation,
    center: number(data.participationAttempts ?? data.observedAttempts), centerLabel: '调用', emptyDetail: '暂无参与样本',
    itemLabel: (item) => item.accountName ?? item.wallet ?? `账号 #${item.accountId}`,
    itemDetail: (item) => `${percent(item.ratio)} · ${number(item.attempts)} 次 · ${item.costRateCnyPerApiUsd == null ? '成本未知' : `¥${number(item.costRateCnyPerApiUsd, 4)}/刀 ${item.costSource === 'detected' ? '探测' : '手工'}`}`,
  })
  $('#pool-participation-legend').innerHTML = participation.length ? participation.map((item, index) => {
    const label = item.accountName ?? item.wallet ?? `账号 #${item.accountId}`
    const cost = item.costRateCnyPerApiUsd == null ? '成本未知' : `¥${number(item.costRateCnyPerApiUsd, 4)}/刀`
    const source = item.costSource === 'detected' ? '探测' : item.costSource === 'manual' ? '手工' : ''
    return `<li><i style="--participation-color:${poolParticipationColors[index % poolParticipationColors.length]}"></i><span title="${escapeHtml(label)}"><b>${escapeHtml(label)}</b><em>${escapeHtml(cost)}${source ? ` · ${source}` : ''}</em></span><strong>${percent(item.ratio)}</strong><small>${number(item.attempts)} 次</small></li>`
  }).join('') : '<li class="empty">暂无参与样本</li>'
}

async function loadPoolQuality() {
  if (poolQualityInFlight !== null) return await poolQualityInFlight
  poolQualityInFlight = requestJson('/api/upstreams/pool-quality').then(renderPoolQuality)
  try { return await poolQualityInFlight } finally { poolQualityInFlight = null }
}

async function scoresPage() {
  const select = $('#score-call-limit')
  const refreshInterval = $('#score-refresh-interval')
  refreshInterval.value = String(readScoreRefreshInterval())
  refreshInterval.addEventListener('change', () => {
    writeScoreRefreshInterval(refreshInterval.value)
    scheduleScoreRefresh()
  })
  $('#score-filter').addEventListener('input', () => {
    scorePage = 1
    renderScoreRows()
  })
  $('#score-prev').addEventListener('click', () => {
    scorePage -= 1
    renderScoreRows()
  })
  $('#score-next').addEventListener('click', () => {
    scorePage += 1
    renderScoreRows()
  })
  const editDialog = $('#score-upstream-edit-dialog')
  const benchmarkDialog = $('#score-benchmark-dialog')
  const createDialog = $('#score-upstream-create-dialog')
  let activeBenchmarkAccount = null
  const benchmarkMarkup = (row) => row ? `<dl class="benchmark-metrics"><div><dt>综合分</dt><dd>${row.score == null ? '—' : number(row.score, 1)}</dd></div><div><dt>状态</dt><dd>${escapeHtml(row.state)}</dd></div><div><dt>模型</dt><dd>${escapeHtml(row.model)}</dd></div><div><dt>耗时</dt><dd>${row.durationMs == null ? '—' : duration(row.durationMs)}</dd></div></dl><small>${escapeHtml(row.benchmarkVersion ?? '')}${row.completedAt ? ` · ${time(row.completedAt)}` : ''}</small>${row.error ? `<p class="dialog-state" data-state="error">${escapeHtml(row.error)}</p>` : ''}` : '<p class="empty">尚未运行评测</p>'
  const benchmarkEventsMarkup = (events = []) => events.length ? events.map((item) => `<li data-state="${item.level === 'error' ? 'failed' : item.level === 'success' ? 'completed' : 'running'}"><time>${time(item.occurredAt)}</time><b>${escapeHtml(item.stage)}</b><span>${escapeHtml(item.message)}${item.durationMs == null ? '' : ` · ${duration(item.durationMs)}`}</span></li>`).join('') : '<li class="empty">等待 Worker 事件</li>'
  const benchmarkHistoryMarkup = (records = []) => records.length ? records.map((item) => `<tr data-benchmark-history="${escapeHtml(item.id)}"><td>${time(item.requestedAt)}</td><td>${escapeHtml(item.model)}</td><td>${escapeHtml(item.state)}</td><td>${item.score == null ? '—' : number(item.score, 1)}</td><td>${item.durationMs == null ? '—' : duration(item.durationMs)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">暂无历史评测</td></tr>'
  const showBenchmarkDetail = (detail) => {
    if (!detail?.run) return
    const run = detail.run
    if (Number(run.accountId) !== Number(activeBenchmarkAccount?.id)) return
    scoreBenchmarksById.set(Number(run.accountId), run)
    $('#score-benchmark-result').innerHTML = benchmarkMarkup(run)
    $('#score-benchmark-run').textContent = `RUN ${run.id}`
    $('#score-benchmark-logs').innerHTML = benchmarkEventsMarkup(detail.events)
    const completed = (detail.events ?? []).filter((item) => item.stage === 'probe-succeeded' || item.stage === 'probe-failed').length
    $('#score-benchmark-progress').value = completed
    $('#score-benchmark-progress-label').textContent = run.state === 'running' ? `${completed} / 6 题完成` : run.state === 'succeeded' ? '6 / 6 题完成' : `${completed} / 6 题完成 · 已失败`
    $('#score-benchmark-state').textContent = run.state === 'running' ? '评测运行中，可关闭窗口后继续。' : run.state === 'succeeded' ? `评测完成，综合分 ${number(run.score, 1)}。` : (run.error ?? '评测失败')
    $('#score-benchmark-submit').disabled = run.state === 'running'
    renderScoreRows()
  }
  const loadBenchmarkHistory = async (accountId) => {
    const history = await requestJson(`/api/upstreams/${accountId}/benchmarks?limit=20`)
    if (Number(activeBenchmarkAccount?.id) === Number(accountId)) $('#score-benchmark-history').innerHTML = benchmarkHistoryMarkup(history.records)
    return history.records ?? []
  }
  const pollBenchmark = async (benchmarkRunId, workflowId, accountId) => {
    try {
      for (;;) {
        const detail = await requestJson(`/api/upstreams/benchmarks/${encodeURIComponent(benchmarkRunId)}`, {}, 20000)
        if (activeBenchmarkAccount?.id === accountId && benchmarkDialog.open) showBenchmarkDetail(detail)
        else if (detail.run) { scoreBenchmarksById.set(Number(accountId), detail.run); renderScoreRows() }
        if (detail.run?.state !== 'running') {
          if (activeBenchmarkAccount?.id === accountId) await loadBenchmarkHistory(accountId).catch(() => {})
          return detail
        }
        await new Promise((resolve) => setTimeout(resolve, 1200))
      }
    } catch (error) {
      const status = await requestJson(`/api/upstreams/jobs/${encodeURIComponent(workflowId)}`).catch(() => null)
      if (activeBenchmarkAccount?.id === accountId && benchmarkDialog.open) {
        $('#score-benchmark-state').textContent = status?.error ?? (error instanceof Error ? error.message : String(error))
        $('#score-benchmark-state').dataset.state = 'error'
      }
    }
  }
  benchmarkDialog.querySelectorAll('[data-dialog-close]').forEach((button) => button.addEventListener('click', () => benchmarkDialog.close()))
  benchmarkDialog.addEventListener('click', (event) => { if (event.target === benchmarkDialog) benchmarkDialog.close() })
  let createOperationId = null
  const createLog = (stage, message, state = '') => {
    const logs = $('#score-upstream-create-logs')
    if (logs.querySelector('.empty')) logs.innerHTML = ''
    const item = document.createElement('li')
    if (state) item.dataset.state = state
    item.innerHTML = `<time>${escapeHtml(new Date().toLocaleTimeString('zh-CN', { hour12: false }))}</time><b>${escapeHtml(stage)}</b><span>${escapeHtml(message)}</span>`
    logs.append(item)
    logs.scrollTop = logs.scrollHeight
  }
  createDialog.querySelectorAll('[data-dialog-close]').forEach((button) => button.addEventListener('click', () => createDialog.close()))
  createDialog.addEventListener('click', (event) => { if (event.target === createDialog) createDialog.close() })
  $('#score-create-upstream').addEventListener('click', async () => {
    $('#score-upstream-create-state').textContent = '正在读取号池选项…'
    const options = await requestJson('/api/upstreams/options')
    const defaults = options.defaults ?? {}
    $('#score-upstream-create-priority').value = String(defaults.priority ?? 1)
    $('#score-upstream-create-capacity').value = String(defaults.capacity ?? 16)
    const defaultIds = (defaults.groupIds ?? [2, 3]).map(Number)
    $('#score-upstream-create-groups').innerHTML = (options.groups ?? []).map((group) => `<label><input type="checkbox" value="${escapeHtml(group.id)}" ${defaultIds.includes(Number(group.id)) ? 'checked' : ''}/><span>${escapeHtml(group.name)} <b>#${escapeHtml(group.id)}</b></span></label>`).join('')
    $('#score-upstream-create-state').textContent = '创建时将自动配置号池、Proxy #3、切号模板，以及账号专属私有探活分组和 API Key。'
    $('#score-upstream-create-state').removeAttribute('data-state')
    $('#score-upstream-create-logs').innerHTML = '<li class="empty">等待提交</li>'
    createOperationId = upstreamOperationId('score-upstream-create')
    createDialog.showModal()
  })
  $('#score-upstream-create-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const button = $('#score-upstream-create-submit')
    button.disabled = true
    const operation = createOperationId ?? (createOperationId = upstreamOperationId('score-upstream-create'))
    try {
      const groups = [...document.querySelectorAll('#score-upstream-create-groups input:checked')].map((input) => Number(input.value))
      if (!groups.length) throw new Error('至少选择一个号池')
      createLog('request', '正在提交创建请求，API key 不会写入日志')
      const recharge = $('#score-upstream-create-recharge').value.trim()
      const submitted = await requestJson('/api/upstreams', { method: 'POST', headers: { 'Idempotency-Key': operation }, body: JSON.stringify({ baseUrl: $('#score-upstream-create-base-url').value, apiKey: $('#score-upstream-create-api-key').value, suffix: $('#score-upstream-create-suffix').value, rateCnyPerApiUsd: Number($('#score-upstream-create-rate').value), priority: Number($('#score-upstream-create-priority').value), capacity: Number($('#score-upstream-create-capacity').value), groupIds: groups, rechargeCny: recharge ? Number(recharge) : undefined, operationId: operation }) })
      $('#score-upstream-create-job').textContent = `JOB ${submitted.workflowId}`
      createLog('accepted', `Temporal 已接受作业 ${submitted.workflowId}`)
      const result = await waitUpstreamJob(submitted.workflowId, (status) => createLog('workflow', String(status.state ?? '处理中')))
      createLog('done', `创建、分组绑定和终态校验完成${result.accounting?.mutation ? `，已记账 ${cny(result.accounting.amountCny)}` : ''}`, 'done')
      $('#score-upstream-create-state').textContent = `创建成功：账号 #${result.account?.id ?? '—'}`
      $('#score-upstream-create-state').dataset.state = 'success'
      $('#score-upstream-create-api-key').value = ''
      createOperationId = null
      await loadUnifiedUpstreamAssets()
      setTimeout(() => { if (createDialog.open) createDialog.close() }, 350)
    } catch (error) {
      $('#score-upstream-create-state').textContent = error instanceof Error ? error.message : String(error)
      $('#score-upstream-create-state').dataset.state = 'error'
      createLog('failed', error instanceof Error ? error.message : String(error), 'failed')
    } finally { button.disabled = false }
  })
  let activeScoreUpstream = null
  const closeEditDialog = () => editDialog.close()
  editDialog.querySelectorAll('[data-dialog-close]').forEach((button) => button.addEventListener('click', closeEditDialog))
  editDialog.addEventListener('click', (event) => { if (event.target === editDialog) closeEditDialog() })
  const scoreEditLog = (stage, message, state = '') => {
    const logs = $('#score-upstream-edit-logs')
    if (logs.querySelector('.empty')) logs.innerHTML = ''
    const item = document.createElement('li')
    if (state) item.dataset.state = state
    item.innerHTML = `<time>${escapeHtml(new Date().toLocaleTimeString('zh-CN', { hour12: false }))}</time><b>${escapeHtml(stage)}</b><span>${escapeHtml(message)}</span>`
    logs.append(item)
    logs.scrollTop = logs.scrollHeight
  }
  const openScoreEdit = (row) => {
    activeScoreUpstream = row
    $('#score-upstream-edit-id').textContent = `#${row.id}`
    $('#score-upstream-edit-summary').textContent = `${row.name} · ${row.status === 'active' && row.schedulable ? '当前可调度' : '当前不可调度'} · 已充值 ${cny(row.rechargeCny)}`
    $('#score-upstream-edit-base-url').textContent = row.baseUrl
    $('#score-upstream-edit-key-prefix').textContent = `Key ${row.keyPrefix ?? '—'}`
    $('#score-upstream-edit-suffix').value = row.suffix ?? ''
    $('#score-upstream-edit-rate').value = row.rateCnyPerApiUsd ?? ''
    $('#score-upstream-edit-recharge').value = ''
    $('#score-upstream-edit-state').textContent = ''
    $('#score-upstream-edit-job').textContent = 'JOB —'
    $('#score-upstream-edit-logs').innerHTML = '<li class="empty">等待提交</li>'
    const usage = scoreUsageById.get(Number(row.id))
    $('#score-upstream-edit-usage-result').innerHTML = usage ? upstreamUsageMarkup(usage, row.rateCnyPerApiUsd) : '<p class="empty">尚未查询</p>'
    editDialog.showModal()
  }
  $('#score-body').addEventListener('click', (event) => {
    const benchmarkButton = event.target.closest('[data-score-benchmark]')
    if (benchmarkButton) {
      const row = scoreUpstreamsById.get(Number(benchmarkButton.dataset.scoreBenchmark))
      if (!row) return
      activeBenchmarkAccount = row
      const accountId = Number(row.id)
      $('#score-benchmark-id').textContent = `#${row.id}`
      $('#score-benchmark-summary').textContent = `${row.name} · ${row.baseUrl} · ${scoreBenchmarkOptions?.provider ?? 'apitest.work compatible'}`
      $('#score-benchmark-model').value = scoreBenchmarkOptions?.model ?? ''
      const latest = scoreBenchmarksById.get(Number(row.id))
      $('#score-benchmark-result').innerHTML = benchmarkMarkup(latest)
      $('#score-benchmark-state').textContent = latest?.state === 'running' ? '该账号正在评测，可关闭窗口后继续。' : '只在点击开始后运行，不会自动跑分，也不会轮换探活 API Key。'
      $('#score-benchmark-state').dataset.state = latest?.state === 'failed' ? 'error' : ''
      $('#score-benchmark-submit').disabled = latest?.state === 'running'
      $('#score-benchmark-run').textContent = latest?.id ? `RUN ${latest.id}` : 'RUN —'
      $('#score-benchmark-logs').innerHTML = '<li class="empty">正在加载运行记录</li>'
      $('#score-benchmark-progress').value = 0
      $('#score-benchmark-progress-label').textContent = '等待启动'
      $('#score-benchmark-history').innerHTML = '<tr><td colspan="5" class="empty">正在加载</td></tr>'
      benchmarkDialog.showModal()
      benchmarkDialog.querySelector('form').scrollTop = 0
      loadBenchmarkHistory(accountId).then((records) => {
        if (Number(activeBenchmarkAccount?.id) !== accountId) return
        const current = records[0]
        if (current?.id) requestJson(`/api/upstreams/benchmarks/${encodeURIComponent(current.id)}`).then(showBenchmarkDetail).catch(() => {})
      }).catch((error) => {
        if (Number(activeBenchmarkAccount?.id) === accountId) $('#score-benchmark-history').innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(error instanceof Error ? error.message : String(error))}</td></tr>`
      })
      return
    }
    const button = event.target.closest('[data-score-upstream-edit]')
    if (!button) return
    const row = scoreUpstreamsById.get(Number(button.dataset.scoreUpstreamEdit))
    if (row) openScoreEdit(row)
  })
  $('#score-benchmark-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!activeBenchmarkAccount) return
    const accountId = Number(activeBenchmarkAccount.id)
    const model = $('#score-benchmark-model').value
    const button = $('#score-benchmark-submit')
    button.disabled = true
    $('#score-benchmark-state').textContent = '正在提交 Temporal…'
    try {
      const submitted = await requestJson(`/api/upstreams/${accountId}/benchmark`, { method: 'POST', body: JSON.stringify({ model }) })
      scoreBenchmarksById.set(accountId, { id: submitted.benchmarkRunId, accountId, model, state: 'running', score: null })
      renderScoreRows()
      benchmarkDialog.close()
      void pollBenchmark(submitted.benchmarkRunId, submitted.workflowId, accountId)
    } catch (error) {
      $('#score-benchmark-state').textContent = error instanceof Error ? error.message : String(error)
      $('#score-benchmark-state').dataset.state = 'error'
    } finally { button.disabled = false }
  })
  $('#score-benchmark-history').addEventListener('click', async (event) => {
    const row = event.target.closest('[data-benchmark-history]')
    if (!row) return
    try { showBenchmarkDetail(await requestJson(`/api/upstreams/benchmarks/${encodeURIComponent(row.dataset.benchmarkHistory)}`)) }
    catch (error) {
      $('#score-benchmark-state').textContent = error instanceof Error ? error.message : String(error)
      $('#score-benchmark-state').dataset.state = 'error'
    }
  })
  $('#score-upstream-edit-usage').addEventListener('click', async () => {
    if (!activeScoreUpstream) return
    const button = $('#score-upstream-edit-usage')
    button.disabled = true
    try {
      const result = await requestJson('/api/upstreams/usage', { method: 'POST', headers: { 'Idempotency-Key': upstreamOperationId(`upstream-usage-${activeScoreUpstream.id}`) }, body: JSON.stringify({ accountIds: [Number(activeScoreUpstream.id)] }) })
      const completed = await waitUpstreamJob(result.workflowId)
      const usage = completed.results?.[0]
      if (usage) scoreUsageById.set(Number(usage.accountId), usage)
      $('#score-upstream-edit-usage-result').innerHTML = usage ? upstreamUsageMarkup(usage, activeScoreUpstream.rateCnyPerApiUsd) : '<p class="empty">未找到可查询账号</p>'
    } catch (error) {
      $('#score-upstream-edit-usage-result').innerHTML = `<p class="empty">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`
    } finally { button.disabled = false }
  })
  $('#score-upstream-edit-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!activeScoreUpstream) return
    const button = $('#score-upstream-edit-submit')
    button.disabled = true
    const id = Number(activeScoreUpstream.id)
    try {
      scoreEditLog('request', `提交账号 #${id} 调整`)
      const submitted = await requestJson(`/api/upstreams/${id}`, { method: 'PATCH', headers: { 'Idempotency-Key': upstreamOperationId(`upstream-update-${id}`) }, body: JSON.stringify({ suffix: $('#score-upstream-edit-suffix').value, rateCnyPerApiUsd: Number($('#score-upstream-edit-rate').value) }) })
      $('#score-upstream-edit-job').textContent = `JOB ${submitted.workflowId}`
      await waitUpstreamJob(submitted.workflowId)
      scoreEditLog('verify', '后缀与费率已生效', 'done')
      const recharge = $('#score-upstream-edit-recharge').value.trim()
      if (recharge) {
        const rechargeJob = await requestJson(`/api/upstreams/${id}/recharge`, { method: 'POST', headers: { 'Idempotency-Key': upstreamOperationId(`upstream-recharge-${id}`) }, body: JSON.stringify({ amountCny: Number(recharge) }) })
        const result = await waitUpstreamJob(rechargeJob.workflowId)
        scoreEditLog('accounting', `已记账 ${cny(result.accounting?.amountCny)}，恢复同源账号 ${number(result.recoveredAccountIds?.length ?? 0)} 个`, 'done')
      }
      $('#score-upstream-edit-state').textContent = '调整完成。'
      $('#score-upstream-edit-state').dataset.state = 'success'
      await loadUnifiedUpstreamAssets()
      setTimeout(() => { if (editDialog.open) editDialog.close() }, 350)
    } catch (error) {
      $('#score-upstream-edit-state').textContent = error instanceof Error ? error.message : String(error)
      $('#score-upstream-edit-state').dataset.state = 'error'
      scoreEditLog('failed', error instanceof Error ? error.message : String(error), 'failed')
    } finally { button.disabled = false }
  })
  document.querySelectorAll('[data-score-sort]').forEach((header) => {
    header.tabIndex = 0
    header.addEventListener('click', () => {
      const key = header.dataset.scoreSort
      scoreSort = scoreSort.key === key
        ? { key, direction: scoreSort.direction === 'desc' ? 'asc' : 'desc' }
        : { key, direction: key === 'accountName' ? 'asc' : 'desc' }
      scorePage = 1
      renderScoreRows()
    })
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        header.click()
      }
    })
  })
  document.querySelectorAll('[data-score-profile]').forEach((button) => {
    button.addEventListener('click', () => {
      activeScoreProfile = button.dataset.scoreProfile
      scorePage = 1
      document.querySelectorAll('[data-score-profile]').forEach((candidate) => {
        const selected = candidate === button
        candidate.classList.toggle('is-active', selected)
        candidate.setAttribute('aria-selected', String(selected))
      })
      renderScoreMetrics()
      renderScoreRows()
    })
  })
  $('#query-scores').addEventListener('click', () => void Promise.allSettled([
    refreshPriorityState(),
    loadUnifiedUpstreamAssets(),
    loadUnifiedQuotaSummary(),
    loadPoolQuality(),
    loadIdleProbeRollingUsage(),
    loadPriorityHistory(),
    loadIdleProbeHistory(),
  ]))
  $('#refresh-scores').addEventListener('click', async () => {
    const button = $('#refresh-scores')
    button.disabled = true
    try {
      await Promise.allSettled([refreshPriorityState(), loadUnifiedUpstreamAssets(), loadUnifiedQuotaSummary(), loadPoolQuality(), loadIdleProbeRollingUsage(), loadPriorityHistory(), loadIdleProbeHistory()])
    }
    catch (error) { $('#score-updated-time').textContent = error instanceof Error ? error.message : String(error) }
    finally { button.disabled = false }
  })
  const [initial] = await Promise.all([
    requestJson('/api/scores'),
    loadUnifiedUpstreamAssets().catch((error) => {
      $('#score-updated-time').textContent = `资产读取失败：${error instanceof Error ? error.message : String(error)}`
    }),
    loadUnifiedQuotaSummary().catch((error) => {
      $('#quota-monitor-state').textContent = `额度读取失败：${error instanceof Error ? error.message : String(error)}`
    }),
    loadPoolQuality().catch((error) => {
      $('#pool-quality-state').textContent = `质量采样读取失败：${error instanceof Error ? error.message : String(error)}`
    }),
    loadIdleProbeRollingUsage().catch((error) => {
      $('#idle-probe-rolling').textContent = `探活 24h：读取失败 · ${error instanceof Error ? error.message : String(error)}`
    }),
  ])
  const options = initial.availableCallOptions ?? []
  const preferredLimit = options.includes(1000) ? 1000 : options[0]
  select.innerHTML = options.map((value) => `<option value="${value}"${value === preferredLimit ? ' selected' : ''}>最近 ${number(value)} 次</option>`).join('')
  renderScores(initial)
  await setupPriorityPanel(options)
  void refreshPriorityState().catch(() => undefined).finally(scheduleScoreRefresh)
  setInterval(async () => {
    if (!document.hidden) {
      const [scores] = await Promise.allSettled([
        requestJson('/api/scores'),
        loadUnifiedQuotaSummary(),
        loadPoolQuality(),
        loadIdleProbeRollingUsage(),
      ])
      if (scores.status === 'fulfilled') renderScores(scores.value)
    }
  }, 30000)
}

const rankingRefreshIntervals = new Set([0, 30, 60, 120, 300])
const rankingRefreshStorageKey = 'api2business.rankingRefreshIntervalSeconds.v1'
let rankingRefreshTimer = null
let rankingRefreshCountdownTimer = null
let rankingRefreshDueAt = null
let rankingLoading = false

function renderRanking(data) {
  const ranking = data.ranking
  $('#ranking-range').textContent = `${ranking.startDate} 至 ${ranking.endDate}`
  $('#ranking-cost').innerHTML = usd(ranking.totals.actualCost)
  $('#ranking-balance').innerHTML = usd(ranking.totals.balanceUsd)
  $('#ranking-recharge').textContent = cny(ranking.totals.rechargeCny)
  $('#ranking-requests').textContent = compact(ranking.totals.requests)
  $('#ranking-tokens').textContent = compact(ranking.totals.tokens)
  $('#ranking-state').textContent = `${ranking.queryCompletedAt ? `更新 ${time(ranking.queryCompletedAt)}` : '已更新'} · DB 查询 ${number(ranking.databaseQueries ?? 0)} 次`
  $('#ranking-body').innerHTML = ranking.rows.length ? ranking.rows.map((row) => `<tr><td class="ranking-rank">${String(row.rank).padStart(2, '0')}</td><td class="account-cell ranking-user"><b>${escapeHtml(row.displayName)}</b></td><td class="usd-cell">${usd(row.actualCost)}</td><td class="usd-cell">${usd(row.balanceUsd)}</td><td class="ranking-recharge usd-cell">${cny(row.rechargeCny)}</td><td class="ranking-number">${compact(row.requests)}</td><td class="ranking-number">${compact(row.tokens)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">当前窗口暂无用量</td></tr>'
}

function renderRankingRefreshCountdown() {
  const target = $('#ranking-refresh-countdown')
  const interval = Number($('#ranking-refresh-interval')?.value)
  if (!target) return
  if (!rankingRefreshIntervals.has(interval) || interval <= 0) return void (target.textContent = '自动刷新已关闭')
  if (rankingRefreshDueAt === null) return void (target.textContent = '下次刷新 --:--')
  const remaining = Math.max(0, Math.ceil((rankingRefreshDueAt - Date.now()) / 1000))
  target.textContent = remaining > 0
    ? `下次刷新 ${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`
    : '自动刷新中…'
}

function clearRankingRefresh() {
  if (rankingRefreshTimer !== null) clearTimeout(rankingRefreshTimer)
  if (rankingRefreshCountdownTimer !== null) clearInterval(rankingRefreshCountdownTimer)
  rankingRefreshTimer = null; rankingRefreshCountdownTimer = null; rankingRefreshDueAt = null
}

function scheduleRankingRefresh() {
  clearRankingRefresh()
  const interval = Number($('#ranking-refresh-interval')?.value)
  if (!rankingRefreshIntervals.has(interval) || interval <= 0) return renderRankingRefreshCountdown()
  rankingRefreshDueAt = Date.now() + interval * 1000
  renderRankingRefreshCountdown()
  rankingRefreshCountdownTimer = setInterval(renderRankingRefreshCountdown, 1000)
  rankingRefreshTimer = setTimeout(async () => {
    await loadRanking(true).catch(() => null)
    scheduleRankingRefresh()
  }, interval * 1000)
}

async function loadRanking(automatic = false) {
  if (rankingLoading) return
  rankingLoading = true
  const button = $('#ranking-refresh')
  button.disabled = true; button.classList.add('is-loading'); button.setAttribute('aria-busy', 'true')
  $('#ranking-state').textContent = automatic ? '自动刷新中，正在排队读取…' : '正在排队读取用户用量…'
  try { renderRanking(await requestJson('/api/ranking', {}, 60000)) }
  catch (error) { $('#ranking-state').textContent = `刷新失败：${error instanceof Error ? error.message : String(error)}`; throw error }
  finally { rankingLoading = false; button.disabled = false; button.classList.remove('is-loading'); button.removeAttribute('aria-busy') }
}

async function rankingPage() {
  const select = $('#ranking-refresh-interval')
  try {
    const stored = Number(localStorage.getItem(rankingRefreshStorageKey))
    if (rankingRefreshIntervals.has(stored)) select.value = String(stored)
  } catch { /* 当前页仍使用默认 60 秒。 */ }
  select.addEventListener('change', () => {
    try { localStorage.setItem(rankingRefreshStorageKey, select.value) } catch { /* 不影响当前刷新。 */ }
    scheduleRankingRefresh()
  })
  $('#ranking-refresh').addEventListener('click', async () => { await loadRanking(); scheduleRankingRefresh() })
  await loadRanking()
  scheduleRankingRefresh()
}

function creditLabel(status) {
  return ({ succeeded: '已充值', dry_run: '模拟充值', disabled: '充值未开启', pending: '充值待确认', failed: '充值失败' })[status] ?? status
}

function renderLottery(data) {
  $('#lottery-prize').textContent = number(data.prizeAmountUsd, 0)
  $('#lottery-remaining').textContent = number(data.remainingDraws)
  $('#lottery-eligible').textContent = number(data.eligibleUserCount)
  $('#lottery-next').textContent = time(data.nextGrantAt)
  $('#lottery-mode').textContent = data.automaticCredit?.enabled ? creditLabel(data.automaticCredit.mode) : '自动充值关闭'
  $('#draw-button').disabled = Number(data.remainingDraws) < 1 || Number(data.eligibleUserCount) < 1
  $('#draw-status').textContent = Number(data.remainingDraws) < 1 ? '今天的机会已用完' : `${data.eligibleUserCount} 名候选用户已就绪`
  $('#record-list').innerHTML = data.records?.length ? data.records.map((record) => `<li><time>${time(record.drawnAt)}</time><b>${escapeHtml(record.winnerDisplayName)}</b><span>$${number(record.prizeAmountUsd, 0)} · ${creditLabel(record.creditStatus)}</span></li>`).join('') : '<li class="empty">暂无开奖记录</li>'
}

async function lotteryPage() {
  let state = await requestJson('/api/lottery')
  renderLottery(state)
  $('#draw-button').addEventListener('click', async () => {
    const button = $('#draw-button')
    button.disabled = true
    $('#draw-status').textContent = '正在抽取活跃用户...'
    try {
      const data = await requestJson('/api/lottery/draw', { method: 'POST', body: '{}' })
      $('#winner-name').textContent = data.record.winnerDisplayName
      $('#winner-prize').textContent = number(data.record.prizeAmountUsd, 0)
      $('#winner-meta').textContent = `${data.record.eligibleCount} 人等概率 · ${creditLabel(data.record.creditStatus)}`
      $('#winner-dialog').showModal()
      state = await requestJson('/api/lottery')
      renderLottery(state)
    } catch (error) {
      $('#draw-status').textContent = error instanceof Error ? error.message : String(error)
      button.disabled = false
    }
  })
  $('#winner-close').addEventListener('click', () => $('#winner-dialog').close())
}

function cny(value) {
  return `¥${number(value, 2)}`
}

function operatingDay() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

let activePlanId = null
let priorityAutomationExists = false
let priorityHistoryRecords = []
let priorityHistoryPage = 1
const priorityHistoryPageSize = 10
let priorityHistoryInFlight = null
let idleProbeHistoryPage = 1
let idleProbeHistoryInFlight = null
const operationsSnapshotKey = 'api2business.operations.snapshot.v1'
let cashPage = 1
let auditPage = 1
let oauthPage = 1
let oauthArchivedPage = 1
let oauthProfile = 'codex'
let oauthRuntimeSnapshot = null
let oauthCurrentRemainingExpected = null
let oauthRefreshTimer = null
let oauthRefreshCountdownTimer = null
let oauthRefreshDueAt = null
let oauthCostLoading = false
let procurementPage = 1
let procurementBudget = null
const oauthRefreshIntervalStorageKey = 'api2business.operations.oauth-refresh-interval.v2'
const oauthRefreshIntervals = new Set([0, 30, 60, 120, 300])

function renderPager(prefix, pagination) {
  const page = Number(pagination?.page ?? 1)
  const totalPages = Number(pagination?.totalPages ?? 1)
  $(`#${prefix}-page`).textContent = `${page} / ${totalPages} · ${number(pagination?.total ?? 0)} 条`
  $(`#${prefix}-prev`).disabled = page <= 1
  $(`#${prefix}-next`).disabled = page >= totalPages
}

function signed(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric === 0) return '0'
  return numeric > 0 ? `+${numeric}` : String(numeric)
}

function setPriorityPlan(rows, visible) {
  priorityPlanRows = new Map((rows ?? []).map((row) => [String(row.accountId), row]))
  priorityPlanVisible = visible
  scoreRows = scoreRows.map((row) => {
    const planRow = priorityPlanRows.get(String(row.accountId))
    if (!planRow) return row
    return {
      ...row,
      priority: planRow.beforePriority,
      score: planRow.score,
      confidence: planRow.confidence ?? row.confidence,
      observedAttempts: planRow.observedAttempts ?? row.observedAttempts,
      failureRate: planRow.failureRate ?? row.failureRate,
      ttftP95Ms: planRow.ttftP95Ms ?? row.ttftP95Ms,
      usage: {
        ...(row.usage ?? {}),
        costRateCnyPerApiUsd: planRow.costRateCnyPerApiUsd,
      },
    }
  })
  renderScoreRows()
}

function clearPriorityPlan(message = '尚未生成调整计划') {
  activePlanId = null
  priorityPlanRows = new Map()
  priorityPlanVisible = false
  $('#confirm-plan').disabled = true
  $('#plan-refresh-state').textContent = message
  renderScoreRows()
}

function planProgress(message, reset = false) {
  const target = $('#plan-progress')
  if (reset) target.innerHTML = ''
  const stamp = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date())
  target.insertAdjacentHTML('beforeend', `<p><time>${stamp}</time> ${escapeHtml(message)}</p>`)
}

async function refreshPriorityState() {
  if (scoreRefreshInFlight !== null) return await scoreRefreshInFlight
  scoreRefreshInFlight = runPriorityStateRefresh()
  try { return await scoreRefreshInFlight } finally { scoreRefreshInFlight = null }
}

async function runPriorityStateRefresh() {
  const button = $('#query-scores')
  const select = $('#score-call-limit')
  const limit = Number(select.value)
  button.disabled = true
  button.classList.add('is-loading')
  button.setAttribute('aria-busy', 'true')
  select.disabled = true
  $('#score-state').textContent = '查询中'
  $('#score-state').dataset.state = 'refreshing'
  $('#plan-refresh-state').textContent = '正在刷新，保留当前显示数据…'
  try {
    const state = await requestJson('/api/scores/rank', {
      method: 'POST',
      body: JSON.stringify({ recentCallLimit: limit }),
    }, 90000)
    renderScores(state)
    clearPriorityPlan()
    $('#plan-refresh-state').textContent = `上次刷新时间：${time(state.refreshedAt ?? state.queryCompletedAt ?? state.collectedAt)} · 最近 ${number(limit)} 次`
    return state
  } catch (error) {
    $('#score-state').textContent = '查询失败'
    $('#plan-refresh-state').textContent = `刷新失败：${error instanceof Error ? error.message : String(error)}`
    throw error
  } finally {
    button.disabled = false
    button.classList.remove('is-loading')
    button.removeAttribute('aria-busy')
    select.disabled = false
  }
}

function renderPriorityHistoryPage() {
  const totalRecords = priorityHistoryRecords.length
  const totalPages = Math.max(1, Math.ceil(totalRecords / priorityHistoryPageSize))
  priorityHistoryPage = Math.min(Math.max(priorityHistoryPage, 1), totalPages)
  const start = (priorityHistoryPage - 1) * priorityHistoryPageSize
  const rows = priorityHistoryRecords.slice(start, start + priorityHistoryPageSize)
  $('#priority-history-body').innerHTML = rows.length ? rows.map((row) => {
    const profiles = Array.isArray(row.profiles) && row.profiles.length ? row.profiles : [row.profile ?? 'codex']
    const label = (profile) => profile === 'grok' ? 'Grok' : 'Codex'
    const profileLabel = profiles.map(label).join(' + ')
    const counts = row.profile_changed_counts ?? {}
    const breakdown = profiles.map((profile) => `${label(profile)} ${number(counts[profile] ?? 0)}`).join(' · ')
    return `<tr>
    <td class="history-profile"><b>${escapeHtml(profileLabel)}</b><small>${escapeHtml(breakdown)}</small></td>
    <td>${time(row.started_at)}</td><td>${row.trigger_type === 'automatic' ? '自动' : '手动'}</td>
    <td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.created_by)}</td>
    <td>${number(row.recent_call_limit)}</td><td>${Number(row.changed_count) === 0 ? '<span class="converged-state">已收敛</span>' : number(row.changed_count)}</td>
    <td>${time(row.completed_at)}</td>
    <td>${row.duration_ms == null ? '—' : `${number(Number(row.duration_ms) / 1000, 1)} 秒`}</td>
  </tr>`
  }).join('') : '<tr><td colspan="9" class="empty">暂无调整记录</td></tr>'
  $('#history-page-state').textContent = totalRecords ? `${priorityHistoryPage} / ${totalPages} · 共 ${number(totalRecords)} 条` : '0 条'
  $('#history-prev').disabled = priorityHistoryPage <= 1
  $('#history-next').disabled = priorityHistoryPage >= totalPages
}

async function loadPriorityHistory() {
  if (priorityHistoryInFlight !== null) return await priorityHistoryInFlight
  const button = $('#refresh-history')
  const previousState = $('#history-page-state').textContent
  button.disabled = true
  button.classList.add('is-loading')
  button.setAttribute('aria-busy', 'true')
  $('#history-page-state').textContent = '正在刷新记录…'
  priorityHistoryInFlight = requestJson('/api/operations/priority-history', { cache: 'no-store' })
    .then((data) => {
      priorityHistoryRecords = data.records ?? []
      renderPriorityHistoryPage()
      return data
    })
  try {
    return await priorityHistoryInFlight
  } catch (error) {
    $('#history-page-state').textContent = `刷新失败：${error instanceof Error ? error.message : String(error)}`
    throw error
  } finally {
    priorityHistoryInFlight = null
    button.disabled = false
    button.classList.remove('is-loading')
    button.removeAttribute('aria-busy')
    if ($('#history-page-state').textContent === '正在刷新记录…') $('#history-page-state').textContent = previousState
  }
}

function renderIdleProbeHistory(data) {
  const rows = data.records ?? []
  const pagination = data.pagination ?? { page: 1, totalPages: 1, total: 0 }
  idleProbeHistoryPage = Number(pagination.page ?? 1)
  const statusLabel = { succeeded: '成功', partial: '部分成功', failed: '失败', skipped: '已跳过' }
  $('#idle-probe-history-body').innerHTML = rows.length ? rows.map((row) => `<tr>
    <td>${time(row.startedAt)}</td>
    <td>${row.triggerType === 'automatic' ? '自动' : '手动'}</td>
    <td><b>${escapeHtml(statusLabel[row.status] ?? row.status)}</b>${row.errorSummary ? `<small>${escapeHtml(row.errorSummary)}</small>` : ''}</td>
    <td>${number(row.planned)}</td><td>${number(row.ready)}</td>
    <td>${number(row.succeeded)}</td><td>${number(row.failed)}</td><td>${number(row.unready)}</td>
    <td>${time(row.completedAt)}</td><td>${number(Number(row.durationMs) / 1000, 1)} 秒</td>
  </tr>`).join('') : '<tr><td colspan="10" class="empty">暂无探活记录</td></tr>'
  $('#probe-history-page-state').textContent = pagination.total ? `${pagination.page} / ${pagination.totalPages} · 共 ${number(pagination.total)} 轮` : '0 轮'
  $('#probe-history-prev').disabled = pagination.page <= 1
  $('#probe-history-next').disabled = pagination.page >= pagination.totalPages
}

async function loadIdleProbeHistory(page = idleProbeHistoryPage) {
  if (idleProbeHistoryInFlight !== null) return await idleProbeHistoryInFlight
  const button = $('#refresh-probe-history')
  button.disabled = true
  button.classList.add('is-loading')
  button.setAttribute('aria-busy', 'true')
  $('#probe-history-page-state').textContent = '正在刷新记录…'
  idleProbeHistoryInFlight = requestJson(`/api/operations/idle-probe/history?page=${page}`, { cache: 'no-store' })
    .then((data) => { renderIdleProbeHistory(data); return data })
  try { return await idleProbeHistoryInFlight }
  catch (error) {
    $('#probe-history-page-state').textContent = `刷新失败：${error instanceof Error ? error.message : String(error)}`
    throw error
  } finally {
    idleProbeHistoryInFlight = null
    button.disabled = false
    button.classList.remove('is-loading')
    button.removeAttribute('aria-busy')
  }
}

async function loadPriorityAutomation() {
  const data = await requestJson('/api/operations/priority-automation')
  const policy = data.automation
  if (!policy) {
    priorityAutomationExists = false
    $('#automation-enabled').value = 'false'
    $('#automation-interval').value = '3600'
    $('#automation-state').textContent = '尚未创建自动调整配置'
    return false
  }
  priorityAutomationExists = true
  $('#automation-enabled').value = String(policy.enabled)
  $('#automation-interval').value = String(policy.interval_seconds)
  $('#automation-limit').value = String(policy.recent_call_limit)
  $('#automation-state').textContent = `下次执行：${time(policy.next_run_at)} · 更新：${time(policy.updated_at)}`
  return true
}

async function setupPriorityPanel(options) {
  $('#automation-limit').innerHTML = options.map((value) => `<option value="${value}"${value === 500 ? ' selected' : ''}>最近 ${value} 条</option>`).join('')
  $('#score-call-limit').addEventListener('change', () => {
    clearPriorityPlan('样本档位已变化，请刷新当前状态或生成新计划')
  })
  $('#refresh-history').addEventListener('click', () => void loadPriorityHistory().catch(() => undefined))
  $('#refresh-probe-history').addEventListener('click', () => void loadIdleProbeHistory().catch(() => undefined))
  $('#probe-history-prev').addEventListener('click', () => void loadIdleProbeHistory(idleProbeHistoryPage - 1).catch(() => undefined))
  $('#probe-history-next').addEventListener('click', () => void loadIdleProbeHistory(idleProbeHistoryPage + 1).catch(() => undefined))
  $('#history-prev').addEventListener('click', () => {
    priorityHistoryPage -= 1
    renderPriorityHistoryPage()
  })
  $('#history-next').addEventListener('click', () => {
    priorityHistoryPage += 1
    renderPriorityHistoryPage()
  })
  $('#automation-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const input = {
      enabled: $('#automation-enabled').value === 'true',
      intervalSeconds: Number($('#automation-interval').value),
      recentCallLimit: Number($('#automation-limit').value),
    }
    const result = await requestJson('/api/operations/priority-automation', {
      method: priorityAutomationExists ? 'PATCH' : 'POST',
      body: JSON.stringify(input),
    })
    priorityAutomationExists = true
    $('#automation-state').textContent = `配置已保存 · 下次执行：${time(result.automation.next_run_at)}`
  })
  $('#generate-plan').addEventListener('click', async () => {
    const button = $('#generate-plan')
    button.disabled = true
    planProgress('开始读取最近调用并生成调整计划', true)
    try {
      const submitted = await requestJson('/api/operations/priority-plans', {
        method: 'POST', body: JSON.stringify({ recentCallLimit: Number($('#score-call-limit').value) }),
      }, 20000)
      const plan = await waitWorkflow(submitted.workflowId, 600000)
      activePlanId = plan.planId
      $('#confirm-plan').disabled = plan.changedCount === 0
      setPriorityPlan(plan.changes, true)
      $('#plan-refresh-state').textContent = `计划生成时间：${time(plan.refreshedAt)} · 最近 ${number(plan.recentCallLimit)} 次`
      planProgress(`计划已生成，包含 ${number(plan.changedCount)} 项调整`)
      await loadPriorityHistory()
    } catch (error) {
      planProgress(`计划生成失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { button.disabled = false }
  })
  $('#confirm-plan').addEventListener('click', async () => {
    if (!activePlanId) return
    const button = $('#confirm-plan')
    button.disabled = true
    $('#generate-plan').disabled = true
    $('#query-scores').disabled = true
    planProgress('已提交确认，Temporal worker 正在批量写入；随后通过读队列回读')
    try {
      const result = await requestJson(`/api/operations/priority-plans/${encodeURIComponent(activePlanId)}/confirm`, { method: 'POST', body: '{}' }, 600000)
      planProgress(`调整成功，后端已写入并由 PostgreSQL 验证 ${number(result.verifiedCount)} 个账号`)
      activePlanId = null
      await Promise.all([refreshPriorityState(), loadPriorityHistory(), loadPriorityAutomation()])
    } catch (error) {
      planProgress(`调整失败：${error instanceof Error ? error.message : String(error)}`)
      activePlanId = null
      await Promise.all([
        loadPriorityHistory().catch(() => undefined),
        loadPriorityAutomation().catch(() => undefined),
      ])
    } finally {
      button.disabled = true
      $('#generate-plan').disabled = false
      $('#query-scores').disabled = false
    }
  })
  await Promise.all([
    loadPriorityHistory(),
    loadIdleProbeHistory(),
    loadPriorityAutomation(),
  ])
}

function renderOperations(ledger, audits) {
  $('#ops-income').textContent = cny(ledger.summary.incomeCny)
  $('#ops-expense').textContent = cny(ledger.summary.expenseCny)
  $('#ops-profit').textContent = cny(ledger.summary.grossProfitCny)
  const rows = ledger.records ?? []
  $('#cash-body').innerHTML = rows.length ? rows.map((row) => `<tr>
    <td>${row.source === 'yaml' ? 'YAML（只读）' : row.source === 'alipay' ? '支付宝（只读）' : row.source === 'upstream-recharge' ? '上游充值（本地账本）' : '手工数据库'}</td>
    <td>${escapeHtml(row.occurred_on ?? row.period ?? '—')}</td>
    <td>${row.direction === 'income' ? '收入' : '支出'}</td>
    <td>${escapeHtml(row.category ?? row.kind ?? '—')}</td>
    <td>${cny(row.amount_cny ?? row.amountCny)}</td>
    <td>${escapeHtml(row.description ?? '')}</td>
    <td>${row.voided_at ? '已作废' : '有效'}</td>
    <td>${row.readOnly || row.voided_at ? '—' : `<button class="text-command cash-void" data-id="${escapeHtml(row.id)}" type="button">作废</button>`}</td>
  </tr>`).join('') : '<tr><td colspan="8" class="empty">暂无经营记录</td></tr>'
  renderPager('cash', ledger.pagination)
  document.querySelectorAll('.cash-void').forEach((button) => button.addEventListener('click', async () => {
    const reason = window.prompt('请输入作废原因')
    if (!reason?.trim()) return
    await requestJson(`/api/operations/cash/${encodeURIComponent(button.dataset.id)}/void`, {
      method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
    })
    await loadOperations()
  }))
  $('#audit-body').innerHTML = audits.records?.length ? audits.records.map((row) => `<tr>
    <td>${time(row.created_at)}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.status)}</td>
    <td>${escapeHtml(row.operator)}</td><td><code>${escapeHtml(JSON.stringify(row.input_summary))}</code></td>
    <td><code>${escapeHtml(JSON.stringify(row.result_summary))}</code></td>
  </tr>`).join('') : '<tr><td colspan="6" class="empty">暂无操作记录</td></tr>'
  renderPager('audit', audits.pagination)
}

function readOperationsSnapshot() {
  try {
    const snapshot = JSON.parse(localStorage.getItem(operationsSnapshotKey) ?? 'null')
    return snapshot?.ledger?.summary && Array.isArray(snapshot?.audits?.records) ? snapshot : null
  } catch {
    return null
  }
}

function writeOperationsSnapshot(ledger, audits) {
  if (cashPage !== 1 || auditPage !== 1) return
  try {
    localStorage.setItem(operationsSnapshotKey, JSON.stringify({ ledger, audits, refreshedAt: new Date().toISOString() }))
  } catch {
    // 隐私模式可能禁用存储，不影响实时数据渲染。
  }
}

async function loadOperations({ showCached = false } = {}) {
  if (showCached && cashPage === 1 && auditPage === 1) {
    const cached = readOperationsSnapshot()
    if (cached) renderOperations(cached.ledger, cached.audits)
  }
  const [ledger, audits] = await Promise.all([
    requestJson(`/api/operations/ledger?page=${cashPage}`),
    requestJson(`/api/operations/audits?page=${auditPage}`),
  ])
  renderOperations(ledger, audits)
  writeOperationsSnapshot(ledger, audits)
}

function finiteChartValue(value) {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function historyChartMarkup(points, { series, valueFormatter, unit = '', ariaLabel = '历史趋势', yMin = null, yMax = null }) {
  const chartWidth = 1000
  if (points.length < 2) return `<text x="${chartWidth / 2}" y="78" text-anchor="middle" class="chart-empty">至少需要两个采样点</text>`
  const chartPoints = points
  const values = series.flatMap(({ key }) => chartPoints
    .filter((point) => point[key] !== null && point[key] !== undefined)
    .map((point) => Number(point[key])).filter(Number.isFinite))
  if (values.length < 2) return `<text x="${chartWidth / 2}" y="78" text-anchor="middle" class="chart-empty">当前指标暂无有效曲线</text>`
  const rawMin = Math.min(...values), rawMax = Math.max(...values)
  const configuredMin = Number(yMin), configuredMax = Number(yMax)
  const lowerBound = yMin !== null && Number.isFinite(configuredMin) && rawMin <= configuredMin ? configuredMin : null
  const upperBound = yMax !== null && Number.isFinite(configuredMax) && rawMax >= configuredMax ? configuredMax : null
  const padding = Math.max((rawMax - rawMin) * 0.08, Math.abs(rawMax) * 0.02, 0.001)
  const min = lowerBound ?? Math.max(0, rawMin - padding)
  const max = upperBound ?? rawMax + padding
  const span = Math.max(max - min, 0.001)
  const plotLeft = 64, plotRight = chartWidth - 14, plotTop = 18, plotBottom = 126
  const x = (index) => plotLeft + index * (plotRight - plotLeft) / Math.max(1, chartPoints.length - 1)
  const y = (value) => plotBottom - (Math.min(max, Math.max(min, value)) - min) / span * (plotBottom - plotTop)
  const formatValue = typeof valueFormatter === 'function' ? valueFormatter : (value) => number(value, 2)
  const ticks = [max, (max + min) / 2, min]
  const grid = ticks.map((value) => {
    const row = y(value)
    return `<text x="56" y="${row + 3}" text-anchor="end" class="chart-axis chart-axis-y">${escapeHtml(formatValue(value))}</text><line x1="${plotLeft}" y1="${row}" x2="${plotRight}" y2="${row}" class="chart-grid"/>`
  }).join('')
  const lines = series.map(({ key, className, label }) => {
    const valuesByPoint = chartPoints.map((point, index) => {
      const value = finiteChartValue(point[key])
      return value === null ? null : { index, value }
    })
    const valid = valuesByPoint.filter((value) => value !== null)
    if (valid.length < 2) return ''
    const segments = []
    let segment = []
    for (const value of valuesByPoint) {
      if (value === null) {
        if (segment.length > 1) segments.push(segment)
        segment = []
      } else segment.push(value)
    }
    if (segment.length > 1) segments.push(segment)
    const current = valuesByPoint.at(-1)
    const clippedHigh = upperBound === null ? '' : valid.filter(({ value }) => value > upperBound).map(({ index, value }) => `<path class="${className} chart-clipped-point" d="M ${x(index) - 4} ${plotTop + 7} L ${x(index)} ${plotTop + 1} L ${x(index) + 4} ${plotTop + 7} Z"><title>${escapeHtml(label ?? key)}：${escapeHtml(formatValue(value))}${unit ? ` ${escapeHtml(unit)}` : ''}（超出图表上限 ${escapeHtml(formatValue(upperBound))}）</title></path>`).join('')
    const clippedLow = lowerBound === null ? '' : valid.filter(({ value }) => value < lowerBound).map(({ index, value }) => `<path class="${className} chart-clipped-point" d="M ${x(index) - 4} ${plotBottom - 7} L ${x(index)} ${plotBottom - 1} L ${x(index) + 4} ${plotBottom - 7} Z"><title>${escapeHtml(label ?? key)}：${escapeHtml(formatValue(value))}${unit ? ` ${escapeHtml(unit)}` : ''}（低于图表下限 ${escapeHtml(formatValue(lowerBound))}）</title></path>`).join('')
    const polylines = segments.map((values) => `<polyline class="${className}" points="${values.map(({ index, value }) => `${x(index)},${y(value)}`).join(' ')}"/>`).join('')
    const currentPoint = current === null || current === undefined ? '' : `<circle class="${className} chart-latest-point" cx="${x(current.index)}" cy="${y(current.value)}" r="3"><title>${escapeHtml(label ?? key)}：${escapeHtml(formatValue(current.value))}${unit ? ` ${escapeHtml(unit)}` : ''}</title></circle>`
    return `${polylines}${currentPoint}${clippedHigh}${clippedLow}`
  }).join('')
  const first = new Date(chartPoints[0].sampledAt), last = new Date(chartPoints.at(-1).sampledAt)
  const label = (date) => date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
  const legend = series.map(({ className, label: seriesLabel }) => `<span class="history-chart-legend-item ${className}">${escapeHtml(seriesLabel ?? '')}</span>`).join('')
  const hoverWidth = (plotRight - plotLeft) / Math.max(1, chartPoints.length - 1)
  const hoverTargets = chartPoints.map((point, index) => {
    const at = new Date(point.sampledAt)
    const details = series.map(({ key, label: seriesLabel }) => {
      const value = Number(point[key])
      return `${seriesLabel ?? key}：${point[key] == null || !Number.isFinite(value) ? '无数据' : `${formatValue(value)}${unit ? ` ${unit}` : ''}`}`
    }).join('\n')
    const left = Math.max(plotLeft, x(index) - hoverWidth / 2)
    const right = Math.min(plotRight, x(index) + hoverWidth / 2)
    return `<g class="chart-hover-column" data-tooltip="${escapeHtml(`${label(at)}\n${details}`)}"><line x1="${x(index)}" y1="${plotTop}" x2="${x(index)}" y2="${plotBottom}"/><rect x="${left}" y="${plotTop}" width="${Math.max(8, right - left)}" height="${plotBottom - plotTop}"/></g>`
  }).join('')
  const capLabels = `${upperBound === null ? '' : `<text x="${plotRight}" y="${plotTop + 10}" text-anchor="end" class="chart-cap-label">展示上限 ${escapeHtml(formatValue(upperBound))}</text>`}${lowerBound === null ? '' : `<text x="${plotRight}" y="${plotBottom - 5}" text-anchor="end" class="chart-cap-label">展示下限 ${escapeHtml(formatValue(lowerBound))}</text>`}`
  return `<title>${escapeHtml(ariaLabel)}</title>${grid}${lines}${hoverTargets}${capLabels}<text x="${plotLeft}" y="147" class="chart-axis">${label(first)}</text><text x="${plotRight}" y="147" text-anchor="end" class="chart-axis">${label(last)}</text><foreignObject x="${plotLeft}" y="1" width="${plotRight - plotLeft}" height="16"><div xmlns="http://www.w3.org/1999/xhtml" class="history-chart-meta"><span>${escapeHtml(unit)}</span><span class="history-chart-legend">${legend}</span></div></foreignObject>`
}

function bindHistoryChartTooltip(svg) {
  if (!svg) return
  const host = svg.parentElement
  if (!host) return
  let tooltip = host.querySelector('.history-chart-tooltip')
  if (!tooltip) {
    tooltip = document.createElement('div')
    tooltip.className = 'history-chart-tooltip'
    host.append(tooltip)
  }
  tooltip.style.display = 'none'
  svg.querySelectorAll('.chart-hover-column').forEach((column) => {
    column.addEventListener('pointerenter', (event) => {
      tooltip.textContent = column.dataset.tooltip ?? ''
      tooltip.style.display = 'block'
      const hostBounds = host.getBoundingClientRect()
      const bounds = tooltip.getBoundingClientRect()
      const left = Math.max(8, Math.min(event.clientX - hostBounds.left + 12, hostBounds.width - bounds.width - 8))
      const top = Math.max(8, Math.min(event.clientY - hostBounds.top + 12, hostBounds.height - bounds.height - 8))
      tooltip.style.left = `${left}px`
      tooltip.style.top = `${top}px`
    })
    column.addEventListener('pointermove', (event) => {
      if (tooltip.style.display !== 'block') return
      const hostBounds = host.getBoundingClientRect()
      const bounds = tooltip.getBoundingClientRect()
      tooltip.style.left = `${Math.max(8, Math.min(event.clientX - hostBounds.left + 12, hostBounds.width - bounds.width - 8))}px`
      tooltip.style.top = `${Math.max(8, Math.min(event.clientY - hostBounds.top + 12, hostBounds.height - bounds.height - 8))}px`
    })
    column.addEventListener('pointerleave', () => { tooltip.style.display = 'none' })
  })
}

function renderOauthForecast() {
  const speed = oauthRuntimeSnapshot?.apiAmountUsdPerHour == null ? null : Number(oauthRuntimeSnapshot.apiAmountUsdPerHour)
  const remaining = oauthCurrentRemainingExpected == null ? null : Number(oauthCurrentRemainingExpected)
  $('#oauth-runtime-speed').textContent = speed !== null && Number.isFinite(speed) && speed > 0 ? `${usdText(speed, 2)}/小时` : '暂不可计算'
  $('#oauth-runtime-remaining').textContent = remaining !== null && Number.isFinite(remaining) ? usdText(remaining, 2) : '暂不可计算'
  const hours = remaining !== null && Number.isFinite(remaining) && remaining <= 0
    ? 0
    : speed !== null && Number.isFinite(speed) && speed > 0 && remaining !== null && Number.isFinite(remaining)
      ? remaining / speed
      : null
  $('#oauth-runtime-hours').textContent = hours !== null ? (hours >= 24 ? `${number(hours / 24, 1)} 天` : `${number(hours, 1)} 小时`) : '暂不可估算'
  const exhaustionAt = hours === null ? null : new Date(Date.now() + hours * 60 * 60 * 1000)
  $('#oauth-runtime-exhaustion').textContent = exhaustionAt === null ? '暂不可估算' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(exhaustionAt)
}

function renderOauthRuntimeSummary(summary) {
  oauthRuntimeSnapshot = summary
  $('#oauth-runtime-consumed').textContent = summary.consumedApiAmountUsd == null ? '暂不可计算' : usdText(summary.consumedApiAmountUsd, 3)
  $('#oauth-runtime-state').textContent = `${summary.sampledAt ? time(summary.sampledAt) : '尚无采样'}${summary.warning ? ` · ${summary.warning}` : ''}`
  const points = Array.isArray(summary.history) ? summary.history : []
  const latestSampleSpeed = points.at(-1)?.sampleApiAmountUsdPerHour
  $('#oauth-runtime-sample-speed').textContent = latestSampleSpeed == null || !Number.isFinite(Number(latestSampleSpeed)) ? '暂不可计算' : usdText(latestSampleSpeed, 2)
  $('#oauth-runtime-consumption-chart').innerHTML = historyChartMarkup(points, {
    series: [
      { key: 'sampleApiAmountUsdPerHour', className: 'chart-sample-speed', label: '当前采样' },
      { key: 'rollingApiAmountUsdPerHour', className: 'chart-rolling-speed', label: '一小时滚动' },
    ],
    valueFormatter: (value) => usdText(value, value < 10 ? 2 : 1), unit: 'API 美元 / 小时', ariaLabel: 'OAuth API 产出速度',
  })
  $('#oauth-runtime-remaining-chart').innerHTML = historyChartMarkup(points, {
    series: [{ key: 'remainingExpectedApiAmountUsd', className: 'chart-schedulable', label: '实时剩余预期' }],
    valueFormatter: (value) => usdText(value, 1), unit: 'API 美元', ariaLabel: 'OAuth 实时剩余预期',
  })
  bindHistoryChartTooltip($('#oauth-runtime-consumption-chart'))
  bindHistoryChartTooltip($('#oauth-runtime-remaining-chart'))
  renderOauthForecast()
}

function renderOauthCost(data) {
  const profileLabel = data.profile === 'grok' ? 'Grok' : 'Codex'
  $('#oauth-cost-pool-title').textContent = `${profileLabel} 当前号池实时成本`
  const pool = data.pool ?? { total: data.total ?? {}, groups: data.groups ?? [] }
  const total = pool.total ?? {}
  oauthCurrentRemainingExpected = total.remainingExpectedApiAmountUsd ?? total.remainingIdealApiAmountUsd ?? null
  renderOauthForecast()
  const health = data.health ?? {}
  const statusCount = (value) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  }
  const statusCounts = (source) => ({
    normal: statusCount(source.normalCount),
    rateLimited: statusCount(source.rateLimitedCount),
    error: statusCount(source.errorCount),
  })
  const statusDonutMarkup = (source, extraClass = '') => {
    const counts = statusCounts(source)
    const statusTotal = counts.normal + counts.rateLimited + counts.error
    if (statusTotal === 0) return `<div class="oauth-status-donut ${extraClass} is-empty" role="img" aria-label="状态未探测"></div>`
    const normalEnd = (counts.normal / statusTotal * 100).toFixed(2)
    const rateEnd = ((counts.normal + counts.rateLimited) / statusTotal * 100).toFixed(2)
    return `<div class="oauth-status-donut ${extraClass}" style="--oauth-normal-end:${normalEnd}%;--oauth-rate-end:${rateEnd}%" role="img" aria-label="正常 ${counts.normal}，限流 ${counts.rateLimited}，错误 ${counts.error}"></div>`
  }
  const expectedAmount = (row) => row.expectedApiAmountUsd ?? row.idealApiAmountUsd
  const configuredExpectedAmount = (row) => row.configuredExpectedApiAmountUsd ?? expectedAmount(row)
  const expectedRemaining = (row) => row.remainingExpectedApiAmountUsd ?? row.remainingIdealApiAmountUsd
  const expectedUnitCost = (row) => row.expectedCnyPerApiUsd ?? row.idealCnyPerApiUsd
  const configuredExpectedUnitCost = (row) => row.configuredExpectedCnyPerApiUsd
  const outputProgress = (row) => {
    const actual = Number(row.apiAmountUsd)
    const expected = Number(expectedAmount(row))
    const configuredExpected = Number(configuredExpectedAmount(row))
    if (!Number.isFinite(actual) || !Number.isFinite(expected) || !Number.isFinite(configuredExpected) || configuredExpected <= 0) {
      return { percent: '—', width: '0', invalidStart: '100', className: 'is-empty', value: null }
    }
    const ratio = actual / configuredExpected
    const invalidStart = Math.min(100, Math.max(0, expected / configuredExpected * 100))
    const invalidated = invalidStart < 99.995
    return {
      percent: `${number(ratio * 100, 1)}%`,
      width: Math.min(100, Math.max(0, ratio * 100)).toFixed(2),
      invalidStart: invalidStart.toFixed(2),
      className: `${ratio > 1 ? 'is-over' : ''}${invalidated ? ' has-invalidated' : ''}`.trim(),
      value: Math.min(100, Math.max(0, ratio * 100)),
    }
  }
  const totalOutputProgress = outputProgress(total)
  $('#oauth-cost-accounts').textContent = number(total.accountCount)
  $('#oauth-cost-active').textContent = `${number(total.usageAccountCount)} 个已有产出`
  $('#oauth-cost-net').textContent = cny(total.netAcquisitionCostCny)
  $('#oauth-cost-gross').textContent = `毛成本 ${cny(total.grossAcquisitionCostCny)} · 退款 ${cny(total.procurementRefundCny)}`
  $('#oauth-cost-output').innerHTML = usd(total.apiAmountUsd, 2)
  const outputProgressBar = $('#oauth-cost-output-progress')
  outputProgressBar.className = `oauth-output-progress oauth-output-total-progress ${totalOutputProgress.className}`
  outputProgressBar.querySelector('span').style.width = `${totalOutputProgress.width}%`
  outputProgressBar.style.setProperty('--invalid-start', `${totalOutputProgress.invalidStart}%`)
  outputProgressBar.setAttribute('aria-valuetext', totalOutputProgress.value === null ? '缺少预期产出配置' : `已产出占预期产出 ${totalOutputProgress.percent}`)
  if (totalOutputProgress.value === null) outputProgressBar.removeAttribute('aria-valuenow')
  else outputProgressBar.setAttribute('aria-valuenow', totalOutputProgress.value.toFixed(1))
  const totalExpectedAmount = expectedAmount(total)
  const totalConfiguredExpectedAmount = configuredExpectedAmount(total)
  const totalExpectedRemaining = expectedRemaining(total)
  $('#oauth-cost-output-progress-label').textContent = totalExpectedAmount == null
    ? '已产出 / 预期 —'
    : `当前产出 ${usdText(total.apiAmountUsd, 2)} / 实时预期 ${usdText(totalExpectedAmount, 2)} / 初始预期 ${usdText(totalConfiguredExpectedAmount, 2)}（100%）· 当前 / 初始 ${totalOutputProgress.percent}`
  $('#oauth-cost-requests').textContent = `${number(total.requestCount)} 次请求 · ${compact(total.tokenCount)} Token`
  $('#oauth-cost-unit').textContent = total.cnyPerApiUsd == null ? '—' : `¥${number(total.cnyPerApiUsd, 5)}`
  const totalExpectedUnitCost = expectedUnitCost(total)
  $('#oauth-cost-ideal-unit').textContent = totalExpectedUnitCost == null ? '—' : `¥${number(totalExpectedUnitCost, 5)}`
  $('#oauth-cost-ideal-output').textContent = `已产出 API 额度 ${usdText(total.apiAmountUsd, 2)}`
  $('#oauth-cost-ideal-remaining').textContent = totalExpectedRemaining == null
    ? '预计还能产出 —（缺少预期配置）'
    : `预计还能产出 ${usdText(totalExpectedRemaining, 2)}`
  $('#oauth-cost-health').textContent = `${number(health.normalCount)} 正常`
  $('#oauth-cost-health-detail').textContent = `限流 ${number(health.rateLimitedCount)} · 错误 ${number(health.errorCount)} · 未探测`
  $('#oauth-cost-health-chart').innerHTML = statusDonutMarkup(health, 'oauth-status-donut-large')
  const exclusions = data.exclusions ?? {}
  const excludedIds = Array.isArray(exclusions.accountIds) ? exclusions.accountIds : []
  const exclusionLabel = excludedIds.length ? ` · 已排除账号 #${excludedIds.join(', #')}` : ''
  const currentWarningLabels = []
  if (number(total.missingCostAccountCount) > 0) currentWarningLabels.push(`缺少采购成本 ${number(total.missingCostAccountCount)} 个`)
  const missingExpectedPlanTypes = total.missingExpectedPlanTypes ?? total.missingIdealPlanTypes
  if (Array.isArray(missingExpectedPlanTypes) && missingExpectedPlanTypes.length > 0) {
    currentWarningLabels.push(`缺少预期产出配置：${missingExpectedPlanTypes.join(', ')}`)
  }
  const warningLabel = currentWarningLabels.length ? ` · ${currentWarningLabels.join('；')}` : ''
  const calibrationLabel = data.expectedCalibration === 'current-api-output-per-used-free-account'
    ? ' · Free 初始预期按当前产出/有产出账号动态估算'
    : ''
  $('#oauth-cost-state').textContent = `${profileLabel} 当前号池核算 · 全历史用量${calibrationLabel}${exclusionLabel}${warningLabel} · ${data.complete ? '数据完整' : '有数据缺口'} · ${number(data.databaseQueries)} 次数据库查询`
  const labels = { k12: 'K12', plus: 'Plus', free: 'Free', team: 'Team' }
  const archived = data.archived ?? { groups: [] }
  const statusDistributionCell = (row) => {
    if (row.scope === 'archived') return '<td class="oauth-status-distribution"><span class="oauth-status-unavailable">—</span></td>'
    const counts = statusCounts(row)
    const total = counts.normal + counts.rateLimited + counts.error
    if (total === 0) return '<td class="oauth-status-distribution"><span class="oauth-status-unavailable">—</span></td>'
    return `<td class="oauth-status-distribution">
      <div class="oauth-status-visual" role="group" aria-label="账号状态分布">${statusDonutMarkup(row)}<div class="oauth-status-legend"><span class="oauth-status-normal">正常 ${counts.normal}</span><span class="oauth-status-rate-limited">限流 ${counts.rateLimited}</span><span class="oauth-status-error">错误 ${counts.error}</span></div></div>
    </td>`
  }
  const outputCell = (row) => {
    const progress = outputProgress(row)
    const rowExpectedAmount = expectedAmount(row)
    const rowConfiguredExpectedAmount = configuredExpectedAmount(row)
    const configuredExpectedLabel = `正常号按 ${usd(row.expectedApiUsdPerAccount ?? row.idealApiUsdPerAccount, 2)} / 号`
    const expectedLabel = rowExpectedAmount == null
      ? '预期产出缺少类型配置'
      : row.expectedOutputBasis === 'status-adjusted'
        ? `${configuredExpectedLabel}，限流/错误按当前产出`
        : `预期 ${usd(row.expectedApiUsdPerAccount ?? row.idealApiUsdPerAccount, 2)} / 号`
    const progressAttributes = progress.value === null
      ? 'aria-valuetext="缺少预期产出配置"'
      : `aria-valuenow="${progress.value.toFixed(1)}"`
    return `<td class="oauth-output-cell">
      <div class="oauth-output-values"><span class="oauth-output-actual">${usd(row.apiAmountUsd, 2)}</span><span class="oauth-output-separator">/</span><span class="oauth-output-ideal">${usd(rowExpectedAmount, 2)}</span><span class="oauth-output-separator">/</span><span class="oauth-output-initial">${usd(rowConfiguredExpectedAmount, 2)}</span><b class="oauth-output-percent ${progress.className}">(初始 ${progress.percent})</b></div>
      <div class="oauth-output-progress ${progress.className}" style="--invalid-start:${progress.invalidStart}%" role="progressbar" aria-label="当前产出占初始预期产出" aria-valuemin="0" aria-valuemax="100" ${progressAttributes}><span style="width:${progress.width}%"></span></div>
      <small class="cost-breakdown">当前产出 / 实时预期 / 初始预期（100%）</small>
      <small class="cost-breakdown">${expectedLabel}</small>
    </td>`
  }
  const renderRow = (row, scopeLabel) => {
    return `<tr>
      <td><b>${scopeLabel}</b></td><td><b>${escapeHtml(labels[row.planType] ?? row.planType)}</b></td><td>${number(row.accountCount)}</td>
      <td>${number(row.usageAccountCount)}</td>${statusDistributionCell(row)}
      <td>${cny(row.netAcquisitionCostCny)}<small class="cost-breakdown">毛 ${cny(row.grossAcquisitionCostCny)} · 退款 ${cny(row.procurementRefundCny)}</small></td>
      <td>${row.averageUnitCostCny == null ? '—' : cny(row.averageUnitCostCny)}<small class="cost-breakdown">净采购成本 / 号</small></td>
      ${outputCell(row)}
      <td class="oauth-cost-calculation"><div><b>${row.cnyPerApiUsd == null ? '—' : `¥${number(row.cnyPerApiUsd, 5)}`}</b><span>/</span><b>${expectedUnitCost(row) == null ? '—' : `¥${number(expectedUnitCost(row), 5)}`}</b><span>/</span><b>${configuredExpectedUnitCost(row) == null ? '—' : `¥${number(configuredExpectedUnitCost(row), 5)}`}</b></div><small class="cost-breakdown">实时成本 / 实时预期成本 / 初始预期成本</small></td>
      <td>${number(row.requestCount)}</td><td>${number(row.tokenCount)}</td>
    </tr>`
  }
  const renderRows = (rows, target, emptyText, scopeLabel) => {
    const rowMarkup = rows.map((row) => renderRow(row, scopeLabel)).join('')
    $(target).innerHTML = rows.length ? rowMarkup : `<tr><td colspan="11" class="empty">${emptyText}</td></tr>`
  }
  renderRows(pool.groups ?? [], '#oauth-cost-body', '当前号池没有 OAuth 账号或采购记录', '当前号池')
  const archivedTotal = archived.total ?? {}
  const archivedWarningLabels = []
  if (number(archivedTotal.missingCostAccountCount) > 0) archivedWarningLabels.push(`缺少采购成本 ${number(archivedTotal.missingCostAccountCount)} 个`)
  const archivedMissingExpectedPlanTypes = archivedTotal.missingExpectedPlanTypes ?? archivedTotal.missingIdealPlanTypes
  if (Array.isArray(archivedMissingExpectedPlanTypes) && archivedMissingExpectedPlanTypes.length > 0) {
    archivedWarningLabels.push(`缺少预期产出配置：${archivedMissingExpectedPlanTypes.join(', ')}`)
  }
  const archivedWarningLabel = archivedWarningLabels.length ? ` · ${archivedWarningLabels.join('；')}` : ''
  const archivedExpectedUnitCost = expectedUnitCost(archivedTotal)
  $('#oauth-archived-state').textContent = `已归档账号全历史用量 · ${number(archivedTotal.accountCount)} 个账号 · 净成本 ${cny(archivedTotal.netAcquisitionCostCny)} · 预期成本 ${archivedExpectedUnitCost == null ? '—' : `¥${number(archivedExpectedUnitCost, 5)}`}${archivedWarningLabel}`
  renderRows(archived.groups ?? [], '#oauth-archived-body', '当前没有已归档 OAuth 采购记录', '已归档')
  renderPager('oauth', data.pagination)
  renderPager('oauth-archived', archived.pagination)
}

function usdText(value, digits = 2) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? `$${numeric.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits })}` : '—'
}

function clearOauthRefreshTimer() {
  if (oauthRefreshTimer !== null) clearTimeout(oauthRefreshTimer)
  if (oauthRefreshCountdownTimer !== null) clearInterval(oauthRefreshCountdownTimer)
  oauthRefreshTimer = null
  oauthRefreshCountdownTimer = null
  oauthRefreshDueAt = null
  renderOauthRefreshCountdown()
}

function renderOauthRefreshCountdown() {
  const target = $('#oauth-cost-refresh-countdown')
  if (!target) return
  const interval = Number($('#oauth-cost-refresh-interval')?.value)
  if (!oauthRefreshIntervals.has(interval) || interval <= 0) {
    target.textContent = '自动刷新已关闭'
    return
  }
  if (oauthRefreshDueAt === null) {
    target.textContent = '下次刷新 --:--'
    return
  }
  const remainingSeconds = Math.max(0, Math.ceil((oauthRefreshDueAt - Date.now()) / 1000))
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60
  target.textContent = remainingSeconds > 0
    ? `下次刷新 ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : '自动刷新中…'
}

function readOauthRefreshInterval() {
  try {
    const value = Number(localStorage.getItem(oauthRefreshIntervalStorageKey))
    return oauthRefreshIntervals.has(value) ? value : null
  } catch {
    return null
  }
}

function writeOauthRefreshInterval(value) {
  try {
    localStorage.setItem(oauthRefreshIntervalStorageKey, String(value))
  } catch {
    // 隐私模式可能禁用存储，当前页面仍按选择继续刷新。
  }
}

function scheduleOauthCostRefresh() {
  clearOauthRefreshTimer()
  const interval = Number($('#oauth-cost-refresh-interval')?.value)
  if (!oauthRefreshIntervals.has(interval) || interval <= 0) return
  oauthRefreshDueAt = Date.now() + interval * 1000
  renderOauthRefreshCountdown()
  oauthRefreshCountdownTimer = setInterval(renderOauthRefreshCountdown, 1000)
  oauthRefreshTimer = setTimeout(async () => {
    oauthRefreshDueAt = null
    renderOauthRefreshCountdown()
    await loadOauthCost({ automatic: true }).catch(() => null)
    scheduleOauthCostRefresh()
  }, interval * 1000)
}

async function loadOauthCost({ automatic = false } = {}) {
  if (oauthCostLoading) return
  oauthCostLoading = true
  const button = $('#oauth-cost-refresh')
  button.disabled = true
  button.classList.add('is-loading')
  button.setAttribute('aria-busy', 'true')
  $('#oauth-cost-state').textContent = automatic ? '自动刷新中，正在通过单连接队列核算…' : '正在通过单连接队列核算…'
  try {
    const runtimeRequest = requestJson(`/api/oauth/runtime-summary?profile=${oauthProfile}`)
      .then(renderOauthRuntimeSummary)
      .catch((error) => {
        $('#oauth-runtime-state').textContent = `采样读取失败：${error instanceof Error ? error.message : String(error)}`
      })
    const data = await requestJson(`/api/operations/oauth-cost?profile=${oauthProfile}&page=${oauthPage}&archivedPage=${oauthArchivedPage}`, {}, 60000)
    renderOauthCost(data)
    await runtimeRequest
  } catch (error) {
    $('#oauth-cost-state').textContent = `核算失败：${error instanceof Error ? error.message : String(error)}`
    throw error
  } finally {
    button.disabled = false
    button.classList.remove('is-loading')
    button.removeAttribute('aria-busy')
    oauthCostLoading = false
    if (!automatic) scheduleOauthCostRefresh()
  }
}

async function operationsPage() {
  $('#cash-date').value = operatingDay()
  $('#cash-prev').addEventListener('click', async () => { cashPage -= 1; await loadOperations() })
  $('#cash-next').addEventListener('click', async () => { cashPage += 1; await loadOperations() })
  $('#audit-prev').addEventListener('click', async () => { auditPage -= 1; await loadOperations() })
  $('#audit-next').addEventListener('click', async () => { auditPage += 1; await loadOperations() })
  $('#cash-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    await requestJson('/api/operations/cash', { method: 'POST', body: JSON.stringify({
      occurredOn: $('#cash-date').value, direction: $('#cash-direction').value,
      category: $('#cash-category').value, amountCny: Number($('#cash-amount').value),
      description: $('#cash-description').value,
    }) })
    event.currentTarget.reset()
    $('#cash-date').value = operatingDay()
    await loadOperations()
  })
  $('#procurement-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    procurementBudget = Number($('#procurement-budget').value)
    procurementPage = 1
    await loadProcurement()
    await loadOperations()
  })
  $('#procurement-prev').addEventListener('click', async () => { procurementPage -= 1; await loadProcurement() })
  $('#procurement-next').addEventListener('click', async () => { procurementPage += 1; await loadProcurement() })
  await Promise.all([loadOperations({ showCached: true }), loadProcurement()])
}

async function oauthCostPage() {
  document.querySelectorAll('[data-oauth-profile]').forEach((button) => {
    button.addEventListener('click', async () => {
      const selected = button.dataset.oauthProfile
      if (selected !== 'codex' && selected !== 'grok' || selected === oauthProfile) return
      oauthProfile = selected
      oauthRuntimeSnapshot = null
      oauthCurrentRemainingExpected = null
      renderOauthForecast()
      oauthPage = 1
      oauthArchivedPage = 1
      document.querySelectorAll('[data-oauth-profile]').forEach((candidate) => {
        const active = candidate.dataset.oauthProfile === oauthProfile
        candidate.classList.toggle('is-active', active)
        candidate.setAttribute('aria-selected', String(active))
      })
      await loadOauthCost()
    })
  })
  const refreshInterval = $('#oauth-cost-refresh-interval')
  const storedRefreshInterval = readOauthRefreshInterval()
  if (storedRefreshInterval !== null) refreshInterval.value = String(storedRefreshInterval)
  refreshInterval.addEventListener('change', () => {
    writeOauthRefreshInterval(refreshInterval.value)
    scheduleOauthCostRefresh()
  })
  $('#oauth-cost-form').addEventListener('submit', async (event) => {
    event.preventDefault(); oauthPage = 1; oauthArchivedPage = 1; await loadOauthCost()
  })
  $('#oauth-prev').addEventListener('click', async () => { oauthPage -= 1; await loadOauthCost() })
  $('#oauth-next').addEventListener('click', async () => { oauthPage += 1; await loadOauthCost() })
  $('#oauth-archived-prev').addEventListener('click', async () => { oauthArchivedPage -= 1; await loadOauthCost() })
  $('#oauth-archived-next').addEventListener('click', async () => { oauthArchivedPage += 1; await loadOauthCost() })
  await loadOauthCost()
  scheduleOauthCostRefresh()
}

function renderProcurement(result) {
  const rows = result.allocations ?? []
  $('#procurement-body').innerHTML = rows.length ? rows.map((row) => `<tr>
    <td>${escapeHtml(row.billingSite)}</td><td>${cny(row.amountCny)}</td><td>${cny(row.denominationCny)}</td>
  </tr>`).join('') : `<tr><td colspan="3" class="empty">未分配 ${cny(result.unallocatedCny)}</td></tr>`
  renderPager('procurement', result.pagination)
}

async function loadProcurement() {
  if (procurementBudget == null) return
  const result = await requestJson('/api/operations/procurement', {
    method: 'POST', body: JSON.stringify({ budgetCny: procurementBudget, page: procurementPage }),
  }, 90000)
  renderProcurement(result)
}

async function accountImportPage() {
  const options = await requestJson('/api/account-import/options')
  const defaults = options.defaults
  const confirmDialog = $('#import-plan-confirm-dialog')
  const confirmForm = $('#import-plan-confirm-form')
  const confirmButton = $('#import-confirm-submit')
  $('#import-priority').value = defaults.priority
  $('#import-capacity').value = defaults.capacity
  $('#import-proxy').value = defaults.sourceProxyId
  $('#import-per-account-proxy').checked = defaults.perAccountProxy === true
  const planType = $('#import-plan-type')
  planType.innerHTML = options.planTypes.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')
  planType.value = defaults.planType
  let planTypeManuallySelected = false
  const inferPlanType = () => {
    if (planTypeManuallySelected) return
    const cost = Number($('#import-unit-cost').value)
    planType.value = Number.isFinite(cost) && cost > 0
      ? (cost < defaults.freeCostThresholdCny ? 'free' : cost > defaults.plusCostThresholdCny ? 'plus' : 'k12')
      : defaults.planType
  }
  planType.addEventListener('change', () => { planTypeManuallySelected = true })
  $('#import-unit-cost').addEventListener('input', inferPlanType)
  $('#import-groups').innerHTML = options.groups.map((group) => `<label><input type="checkbox" value="${group.id}" ${defaults.groupIds.includes(group.id) ? 'checked' : ''}/><span>${escapeHtml(group.name)} <b>#${group.id}</b></span></label>`).join('')
  const fileInput = $('#import-file')
  const zone = $('#drop-zone')
  let importInputFormat = 'json'
  let importContent = ''
  let importPreview = null
  let previewSequence = 0
  const platformSelect = $('#import-platform')
  const detectedImportPlatform = () => {
    if (importPreview?.platform) return importPreview.platform
    if (importInputFormat !== 'json') return null
    try {
      const payload = JSON.parse(importContent)
      const platforms = new Set((payload?.accounts ?? []).map((account) => String(account?.platform ?? '').toLowerCase()))
      return platforms.size === 1 && (platforms.has('openai') || platforms.has('grok')) ? [...platforms][0] : null
    } catch { return null }
  }
  const applyDetectedPlatform = () => {
    const detected = detectedImportPlatform()
    const platform = platformSelect.value === 'auto' ? detected : platformSelect.value
    if (!platform) {
      $('#import-platform-state').textContent = importInputFormat === 'zip' ? '正在解析 ZIP 并识别账号' : '等待识别 Codex 或 Grok'
      return
    }
    if (platform === 'grok') {
      planType.value = 'free'
      planTypeManuallySelected = false
    }
    document.querySelectorAll('#import-groups input').forEach((input) => {
      input.checked = platform === 'grok' ? Number(input.value) === 6 : defaults.groupIds.includes(Number(input.value))
    })
    $('#file-state').dataset.platform = platform
    const source = platformSelect.value === 'auto' ? '自动识别' : '手动选择'
    const preview = importPreview
      ? `${importPreview.source.jsonFileCount} 个 JSON · 去重 ${importPreview.source.duplicateAccountCount} · ${importPreview.accountCount} 个账号 · `
      : ''
    $('#import-platform-state').textContent = platform === 'grok'
      ? `${preview}${source} Grok · 当前固定 Free · 默认导入 Grok #6`
      : `${preview}${source} Codex · 类型继续按单价自动选择或手动调整`
  }
  platformSelect.addEventListener('change', applyDetectedPlatform)
  const importedAccountCount = () => {
    if (importPreview?.accountCount) return importPreview.accountCount
    if (importInputFormat !== 'json') return 0
    try {
      const payload = JSON.parse(importContent)
      return Array.isArray(payload?.accounts) ? payload.accounts.length : 0
    } catch { return 0 }
  }
  const planTypeLabel = (value) => ({ free: 'Free', k12: 'K12', plus: 'Plus / Pro', team: 'Team' })[value] ?? String(value).toUpperCase()
  const planTypeDescription = (value) => ({
    free: '免费额度账号',
    k12: 'K12 OAuth 账号',
    plus: 'Plus 或 Pro OAuth 账号',
    team: 'Team OAuth 账号',
  })[value] ?? 'OAuth 账号'
  const openPlanTypeConfirmation = () => {
    const detected = detectedImportPlatform()
    const selectedPlatform = platformSelect.value === 'auto' ? detected : platformSelect.value
    const currentPlanType = selectedPlatform === 'grok' ? 'free' : planType.value
    const accountCount = importedAccountCount()
    const unitCost = Number($('#import-unit-cost').value)
    $('#import-confirm-account-count').textContent = `${number(accountCount)} 个`
    $('#import-confirm-platform').textContent = selectedPlatform === 'grok' ? 'Grok' : 'Codex'
    $('#import-confirm-unit-cost').textContent = Number.isFinite(unitCost) && unitCost > 0 ? `${cny(unitCost)} / 个` : '—'
    $('#import-confirm-types').innerHTML = options.planTypes.map((item) => {
      const disabled = selectedPlatform === 'grok' && item.id !== 'free'
      const current = item.id === currentPlanType
      return `<label class="import-confirm-type${current ? ' is-current' : ''}${disabled ? ' is-disabled' : ''}">
        <input type="radio" name="import-confirm-plan-type" value="${escapeHtml(item.id)}" ${disabled ? 'disabled' : ''} />
        <span><strong>${escapeHtml(planTypeLabel(item.id))}</strong><small>${escapeHtml(planTypeDescription(item.id))}</small></span>
        ${current ? '<em>当前建议</em>' : ''}
      </label>`
    }).join('')
    confirmButton.disabled = true
    $('#import-confirm-state').textContent = selectedPlatform === 'grok' ? 'Grok 当前仅支持 Free，请明确选择后提交。' : '请选择本批 OAuth 账号的实际类型。'
    $('#import-confirm-state').removeAttribute('data-state')
    if (!confirmDialog.open) confirmDialog.showModal()
  }
  const updateUnitCostFromTotal = () => {
    const total = Number($('#import-total-cost').value)
    const count = importedAccountCount()
    if (!Number.isFinite(total) || total <= 0 || count < 1) return
    $('#import-unit-cost').value = (Math.round((total / count) * 100) / 100).toFixed(2)
    inferPlanType()
  }
  $('#import-total-cost').addEventListener('input', updateUnitCostFromTotal)
  const bytesToBase64 = (bytes) => {
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    }
    return btoa(binary)
  }
  const loadFile = async (file) => {
    if (!file) return
    const sequence = ++previewSequence
    const zip = file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip'
    importInputFormat = zip ? 'zip' : 'json'
    importPreview = null
    importContent = zip ? bytesToBase64(new Uint8Array(await file.arrayBuffer())) : await file.text()
    $('#import-json').value = zip ? '正在安全解析并合并 ZIP 内的 JSON…' : importContent
    $('#import-json').readOnly = zip
    $('#import-json').placeholder = zip ? 'ZIP 解析后将在这里展示合并 JSON' : '粘贴 Sub2API 导出的 JSON'
    $('#file-state').textContent = `${file.name} · ${number(file.size)} bytes`
    if (!zip) {
      applyDetectedPlatform()
      updateUnitCostFromTotal()
      return
    }
    $('#import-submit').disabled = true
    $('#import-platform-state').textContent = '正在解析 ZIP、合并 JSON 并识别账号数量'
    try {
      const preview = await requestJson('/api/account-import/preview', {
        method: 'POST', body: JSON.stringify({ content: importContent, inputFormat: 'zip' }),
      }, 30000)
      if (sequence !== previewSequence) return
      importPreview = preview
      $('#import-json').value = JSON.stringify(JSON.parse(preview.content), null, 2)
      $('#file-state').textContent = `${file.name} · ${number(file.size)} bytes · ${preview.accountCount} 个账号`
      applyDetectedPlatform()
      updateUnitCostFromTotal()
    } catch (error) {
      if (sequence !== previewSequence) return
      importPreview = null
      $('#import-json').value = ''
      $('#file-state').textContent = `${file.name} · ZIP 解析失败`
      $('#import-platform-state').textContent = error instanceof Error ? error.message : String(error)
    } finally {
      if (sequence === previewSequence) $('#import-submit').disabled = false
    }
  }
  $('#import-json').addEventListener('input', () => {
    if ($('#import-json').readOnly) return
    importInputFormat = 'json'
    importContent = $('#import-json').value
    importPreview = null
    applyDetectedPlatform()
    updateUnitCostFromTotal()
  })
  zone.addEventListener('click', () => fileInput.click())
  zone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') fileInput.click() })
  fileInput.addEventListener('change', () => loadFile(fileInput.files?.[0]))
  for (const eventName of ['dragenter', 'dragover']) zone.addEventListener(eventName, (event) => { event.preventDefault(); zone.classList.add('is-dragging') })
  for (const eventName of ['dragleave', 'drop']) zone.addEventListener(eventName, (event) => { event.preventDefault(); zone.classList.remove('is-dragging') })
  zone.addEventListener('drop', (event) => loadFile(event.dataTransfer?.files?.[0]))
  const renderJob = (job) => {
    $('#import-state').textContent = ({ queued: '排队中', running: '导入中', succeeded: '已完成', failed: '失败' })[job.state]
    $('#import-state').dataset.state = job.state === 'succeeded' ? 'ready' : job.state === 'failed' ? 'unavailable' : 'refreshing'
    $('#import-job-id').textContent = `JOB ${job.id}`
    const labels = options.groups.filter((group) => job.settings.groupIds.includes(group.id)).map((group) => `${group.name} #${group.id}`).join('、')
    const result = job.result?.result
    const runtimeSettings = job.result?.settings ?? {}
    const perAccountProxy = runtimeSettings.assignmentMode === 'per-account-random' || job.settings.perAccountProxy === true
    const assignments = result?.proxyAssignments ?? []
    const usedProxies = new Set(assignments.filter((item) => item?.bound).map((item) => item.proxyId)).size
    const sharedProxyId = runtimeSettings.sharedProxyId ?? result?.sharedProxyId
    const proxyOutcome = perAccountProxy
      ? (assignments.length ? ` · 已分配 ${assignments.filter((item) => item?.bound).length} 个账号 / 使用 ${usedProxies} 个 Proxy` : '')
      : (sharedProxyId ? ` · 整批共用 Proxy #${sharedProxyId}` : '')
    const outcome = result ? ` · 新建 ${result.createdIds?.length ?? 0} · 更新 ${result.updatedIds?.length ?? 0} · 跳过 ${result.skippedIds?.length ?? result.skipped ?? 0} · 失败 ${result.failed ?? 0}${proxyOutcome}` : ''
    const accounting = job.accounting ? ` · 已记账 ${job.accounting.recordedCount} 个 / ${cny(job.accounting.totalCostCny)}` : ''
    const source = job.source?.format === 'zip' ? `ZIP ${job.source.jsonFileCount} 个 JSON · 包内去重 ${job.source.duplicateAccountCount}` : 'JSON'
    const platform = job.source?.platform === 'grok' ? 'Grok' : 'GPT'
    $('#import-summary').textContent = `${source} · ${platform} · ${job.accountCount} 个账号 · SHA256 ${job.fingerprint} · 类型 ${job.settings.planType.toUpperCase()} · 单价 ${cny(job.settings.unitCostCny)} / 个 · 优先级 ${job.settings.priority} · 容量 ${job.settings.capacity} · ${labels} · 代理池基准 #${job.settings.sourceProxyId}${outcome}${accounting}`
    const recordedCount = Number(job.accounting?.recordedCount)
    const acquisitionCost = Number(job.accounting?.totalCostCny)
    const expectedPerAccount = Number(options.initialExpectedApiUsdPerAccount?.[job.settings.planType])
    const economicsReady = job.state === 'succeeded' && Number.isFinite(recordedCount) && recordedCount >= 0
      && Number.isFinite(acquisitionCost) && acquisitionCost >= 0 && Number.isFinite(expectedPerAccount) && expectedPerAccount > 0
    const expectedOutput = economicsReady ? recordedCount * expectedPerAccount : null
    const initialExpectedCost = expectedOutput > 0 ? acquisitionCost / expectedOutput : null
    $('#import-economics').classList.toggle('is-pending', !economicsReady)
    $('#import-economics').classList.toggle('is-ready', economicsReady)
    $('#import-acquisition-cost').textContent = economicsReady ? cny(acquisitionCost) : '—'
    $('#import-accounted-count').textContent = economicsReady ? `新增并记账 ${recordedCount} 个账号` : '作业完成后按新增账号核算'
    $('#import-expected-output').textContent = economicsReady ? usdText(expectedOutput, 2) : '—'
    $('#import-expected-basis').textContent = economicsReady ? `${job.settings.planType.toUpperCase()} · ${usdText(expectedPerAccount, 1)} / 号` : '复用 OAuth 初始预期口径'
    $('#import-expected-cost').textContent = initialExpectedCost === null ? (economicsReady ? '无新增成本' : '—') : `¥${number(initialExpectedCost, 4)}`
    $('#import-logs').innerHTML = job.logs.length ? job.logs.map((log) => `<li data-state="${escapeHtml(log.state)}"><time>${time(log.timestamp)}</time><b>${escapeHtml(log.stage)}</b><span>${escapeHtml(log.message)}</span></li>`).join('') : '<li class="empty">等待作业启动</li>'
    $('#import-logs').scrollTop = $('#import-logs').scrollHeight
  }
  let importSubmitting = false
  const submitImport = async (confirmedPlanType) => {
    if (importSubmitting) return
    importSubmitting = true
    planType.value = confirmedPlanType
    planTypeManuallySelected = true
    const button = $('#import-submit')
    button.disabled = true
    confirmButton.disabled = true
    if (confirmDialog.open) confirmDialog.close()
    try {
      const groupIds = [...document.querySelectorAll('#import-groups input:checked')].map((input) => Number(input.value))
      const response = await requestJson('/api/account-import/jobs', { method: 'POST', body: JSON.stringify({
        content: importInputFormat === 'zip' ? importContent : $('#import-json').value, inputFormat: importInputFormat,
        priority: Number($('#import-priority').value), capacity: Number($('#import-capacity').value),
        groupIds, sourceProxyId: Number($('#import-proxy').value),
        perAccountProxy: $('#import-per-account-proxy').checked,
        unitCostCny: Number($('#import-unit-cost').value), planType: confirmedPlanType,
        platform: platformSelect.value === 'auto' ? undefined : platformSelect.value, confirm: true,
      }) }, 30000)
      let job = response.job; renderJob(job)
      while (job.state === 'queued' || job.state === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        job = (await requestJson(`/api/account-import/jobs/${encodeURIComponent(job.id)}`)).job; renderJob(job)
      }
    } finally {
      importSubmitting = false
      button.disabled = false
    }
  }
  $('#import-form').addEventListener('submit', (event) => {
    event.preventDefault()
    if (importInputFormat === 'zip' && !importPreview) {
      $('#import-platform-state').textContent = 'ZIP 尚未成功解析，不能提交导入'
      return
    }
    openPlanTypeConfirmation()
  })
  $('#import-confirm-types').addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLInputElement) || event.target.name !== 'import-confirm-plan-type') return
    confirmButton.disabled = false
    $('#import-confirm-state').textContent = `将按 ${planTypeLabel(event.target.value)} 类型导入并记账。`
    $('#import-confirm-state').dataset.state = 'success'
  })
  confirmForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const selected = confirmForm.querySelector('input[name="import-confirm-plan-type"]:checked')
    if (!selected) {
      $('#import-confirm-state').textContent = '必须明确选择账号类型。'
      $('#import-confirm-state').dataset.state = 'error'
      return
    }
    void submitImport(selected.value)
  })
  const closeConfirmation = () => { if (confirmDialog.open && !importSubmitting) confirmDialog.close() }
  $('#import-confirm-cancel').addEventListener('click', closeConfirmation)
  $('#import-confirm-close-icon').addEventListener('click', closeConfirmation)
  confirmDialog.addEventListener('click', (event) => { if (event.target === confirmDialog) closeConfirmation() })
}

let upstreamPage = 1
let upstreamSearch = ''
let activeUpstream = null
let upstreamValuationPolicy = { defaultCnyPerApiUsd: 1, walletCnyPerApiUsd: {} }

function normalizedUpstreamWallet(value) {
  return String(value ?? '').trim().split(/\s+/u)[0].replace(/\/v1\/?$/u, '').replace(/\/$/u, '')
}

function upstreamWalletCnyRate(baseUrl) {
  const wallet = normalizedUpstreamWallet(baseUrl)
  const configuredRate = Number(upstreamValuationPolicy.walletCnyPerApiUsd?.[wallet])
  const defaultRate = Number(upstreamValuationPolicy.defaultCnyPerApiUsd)
  return Number.isFinite(configuredRate) && configuredRate > 0 ? configuredRate : defaultRate
}

function upstreamBalancePresentation(result) {
  if (!result) return { primary: '未查询', secondary: '—', known: false }
  if (result.ok !== true) return { primary: '查询失败', secondary: result.error ?? '—', known: false }
  const quota = result.quota ?? {}
  const remaining = Number(quota.remaining)
  if (quota.unit !== 'USD' || quota.remaining == null || !Number.isFinite(remaining)) {
    return { primary: '账号余额未知', secondary: '未取得账号级 USD 余额', known: false }
  }
  const rate = upstreamWalletCnyRate(result.baseUrl)
  const safeRemaining = Math.max(0, remaining)
  return {
    primary: cny(safeRemaining * rate),
    secondary: `$${number(safeRemaining, 2)} · ${number(rate, 2)} 元/$`,
    known: true,
  }
}

function upstreamStatus(row) {
  if (row.status === 'active' && row.schedulable) return { label: '可调度', className: 'is-available' }
  if (row.status === 'active') return { label: '已停调度', className: 'is-limited' }
  return { label: row.status || '异常', className: 'is-error' }
}

function upstreamGroupMarkup(row) {
  const ids = Array.isArray(row.groupIds) ? row.groupIds : []
  const names = Array.isArray(row.groupNames) ? row.groupNames : []
  if (!ids.length && !names.length) return '<span>未分组</span>'
  const compactNames = (names.length ? names : ['分组']).map((name) => {
    const value = String(name)
    return value.length > 3 ? `${value.slice(0, 3)}…` : value
  })
  return `<span title="${escapeHtml(names.join('、') || '分组')} · ${escapeHtml(ids.map((id) => `#${id}`).join('、'))}">${escapeHtml(compactNames.join('、'))} · ${escapeHtml(ids.map((id) => `#${id}`).join('、'))}</span>`
}

function upstreamOperationId(prefix) {
  return `${prefix}-${typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

function upstreamUsageMarkup(result, manualRate = null) {
  const quota = result.quota ?? {}
  const usage = result.usage ?? {}
  const balance = upstreamBalancePresentation(result)
  const multiplier = upstreamMultiplierPresentation(result, manualRate)
  const warning = result.warning ? `<p>${escapeHtml(result.warning)}</p>` : ''
  const error = result.error ? `<p>${escapeHtml(result.error)}</p>` : ''
  return `<article class="upstream-usage-result" data-ok="${result.ok === true}">
    <header><div><b>${escapeHtml(result.accountName ?? `账号 #${result.accountId}`)}</b><small>#${escapeHtml(result.accountId)} · ${escapeHtml(result.provider ?? 'unknown')}</small></div><small>${number(result.durationMs)} ms</small></header>
    <dl><dt>账号余额</dt><dd><b>${escapeHtml(balance.primary)}</b><small>${escapeHtml(balance.secondary)}</small></dd><dt>探测成本</dt><dd><b>${escapeHtml(multiplier.primary)}</b><small>${escapeHtml(multiplier.secondary)}</small><small>${escapeHtml(multiplier.comparison)}</small></dd><dt>已用额度</dt><dd>${quota.used == null ? '—' : `${escapeHtml(number(quota.used, 2))} USD`}</dd><dt>Token</dt><dd>${usage.totalTokens == null ? '—' : compact(usage.totalTokens)}</dd><dt>请求</dt><dd>${usage.requestCount == null ? '—' : number(usage.requestCount)}</dd><dt>API 费用</dt><dd>${usage.actualCostUsd == null ? usage.costUsd == null ? '—' : usd(usage.costUsd) : usd(usage.actualCostUsd)}</dd><dt>查询时间</dt><dd>${time(result.queriedAt)}</dd></dl>${warning}${error}
  </article>`
}

function upstreamMultiplierPresentation(result, manualRate = null) {
  const probe = result?.billingMultiplier ?? {}
  if (probe.value == null || !Number.isFinite(Number(probe.value)) || Number(probe.value) <= 0) {
    const retained = probe.syncStatus === 'retained-manual' ? ' · 已保留手工费率' : ''
    return { primary: '未知', secondary: `暂无可信正倍率证据${retained}`, comparison: probe.syncMessage ?? '—', mismatch: false }
  }
  const rawMultiplier = Number(probe.value)
  const walletRate = upstreamWalletCnyRate(result?.baseUrl)
  const detectedCost = rawMultiplier * walletRate
  const source = probe.source === 'sub2api-live' ? 'Sub2API 实时有效' : 'New API 最近消费'
  const safeManualRate = Number(manualRate)
  const hasManualRate = manualRate != null && Number.isFinite(safeManualRate) && safeManualRate > 0
  const difference = hasManualRate ? (detectedCost - safeManualRate) / safeManualRate : null
  const mismatch = difference !== null && Math.abs(difference) > 0.005
  const comparison = difference === null
    ? '未登记结构化手工费率'
    : mismatch
      ? `较手工 ${difference > 0 ? '+' : ''}${number(difference * 100, 1)}%`
      : '与手工一致'
  const syncLabels = {
    synchronized: '已按探测同步',
    'already-synchronized': '手工费率已一致',
    'retained-manual': '已保留手工费率',
    failed: '费率同步失败',
  }
  const syncLabel = syncLabels[probe.syncStatus]
  return {
    primary: `¥${number(detectedCost, 4)}/刀`,
    secondary: `${number(rawMultiplier, 4)}× × ${number(walletRate, 2)} 元/$ · ${source}`,
    comparison: syncLabel ? `${comparison} · ${syncLabel}` : comparison,
    mismatch,
  }
}

async function waitUpstreamJob(workflowId, onStatus = () => {}, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs
  let previousState = ''
  for (;;) {
    const status = await requestJson(`/api/upstreams/jobs/${encodeURIComponent(workflowId)}`, {}, 20000)
    const state = String(status.state ?? 'unknown')
    if (state !== previousState) {
      previousState = state
      onStatus(status)
    }
    if (status.terminal) {
      if (status.state !== 'completed') throw new Error(status.error ?? `上游作业${status.state ?? '失败'}`)
      if (!status.result?.ok) throw new Error(status.result?.error ?? '上游作业未成功完成')
      return status.result
    }
    if (Date.now() >= deadline) throw new Error('上游作业等待超时，请到上游列表核对作业结果')
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

async function waitWorkflow(workflowId, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await requestJson(`/api/admin/workflows/${encodeURIComponent(workflowId)}`, {}, 20000)
    if (status.terminal) {
      if (status.state !== 'completed') throw new Error(status.error ?? `作业${status.state ?? '失败'}`)
      if (!status.result?.ok) throw new Error(status.result?.error ?? '作业未成功完成')
      return status.result
    }
    if (Date.now() >= deadline) throw new Error('作业等待超时，请使用 workflow status 查询结果')
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

async function upstreamsPage() {
  const createDialog = $('#upstream-create-dialog')
  const editDialog = $('#upstream-edit-dialog')
  for (const dialog of [createDialog, editDialog]) {
    dialog.querySelectorAll('[data-dialog-close]').forEach((button) => {
      button.addEventListener('click', () => dialog.close())
    })
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close()
    })
  }
  const setState = (message, state = '') => {
    $('#upstream-state').textContent = message
    $('#upstream-state').dataset.state = state
  }
  let lastUpstreamRows = []
  let lastUpstreamData = null
  const upstreamUsageById = new Map()
  let createOperationId = null
  let editRechargeOperationId = null
  let upstreamGroupOptions = []
  let quotaRefreshTimer = null
  let quotaRefreshCountdownTimer = null
  let quotaRefreshDueAt = null
  const quotaRefreshStorageKey = 'api2business.operations.upstream-quota-refresh-interval.v1'
  const renderQuotaRefreshCountdown = () => {
    const target = $('#upstream-quota-refresh-countdown')
    const interval = Number($('#upstream-quota-refresh-interval')?.value)
    if (!target) return
    if (!oauthRefreshIntervals.has(interval) || interval <= 0) {
      target.textContent = '自动刷新已关闭'
      return
    }
    if (quotaRefreshDueAt === null) {
      target.textContent = '下次刷新 --:--'
      return
    }
    const remainingSeconds = Math.max(0, Math.ceil((quotaRefreshDueAt - Date.now()) / 1000))
    target.textContent = remainingSeconds > 0
      ? `下次刷新 ${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}`
      : '自动刷新中…'
  }
  const clearQuotaRefresh = () => {
    if (quotaRefreshTimer !== null) clearTimeout(quotaRefreshTimer)
    if (quotaRefreshCountdownTimer !== null) clearInterval(quotaRefreshCountdownTimer)
    quotaRefreshTimer = null
    quotaRefreshCountdownTimer = null
    quotaRefreshDueAt = null
  }
  const scheduleQuotaRefresh = () => {
    clearQuotaRefresh()
    const interval = Number($('#upstream-quota-refresh-interval')?.value)
    if (!oauthRefreshIntervals.has(interval) || interval <= 0) {
      renderQuotaRefreshCountdown()
      return
    }
    quotaRefreshDueAt = Date.now() + interval * 1000
    renderQuotaRefreshCountdown()
    quotaRefreshCountdownTimer = setInterval(renderQuotaRefreshCountdown, 1000)
    quotaRefreshTimer = setTimeout(async () => {
      quotaRefreshDueAt = null
      renderQuotaRefreshCountdown()
      await loadQuotaSummary()
      scheduleQuotaRefresh()
    }, interval * 1000)
  }
  const renderQuotaCharts = (history) => {
    const points = Array.isArray(history) ? history : []
    $('#quota-balance-chart').innerHTML = historyChartMarkup(points, {
      series: [
        { key: 'sampleApiAmountUsdPerHour', className: 'chart-sample-speed', label: '当前采样' },
        { key: 'rollingApiAmountUsdPerHour', className: 'chart-rolling-speed', label: '一小时滚动' },
      ],
      valueFormatter: (value) => usdText(value, value < 10 ? 2 : 1), unit: 'API 美元 / 小时', ariaLabel: '上游 API 消耗速率',
    })
    $('#quota-cost-chart').innerHTML = historyChartMarkup(points, {
      series: [
        { key: 'sampleRealtimeCostCnyPerApiUsd', className: 'chart-cost', label: '当前采样' },
        { key: 'realtimeCostCnyPerApiUsd', className: 'chart-rolling-cost', label: '一小时滚动' },
      ],
      valueFormatter: (value) => `¥${number(value, 4)}`, unit: '人民币 / API 美元', ariaLabel: '上游当前采样与一小时滚动实时成本', yMax: 0.3,
    })
    bindHistoryChartTooltip($('#quota-balance-chart'))
    bindHistoryChartTooltip($('#quota-cost-chart'))
  }
  const loadQuotaSummary = async () => {
    try {
      const summary = await requestJson('/api/upstreams/quota-summary')
      const points = Array.isArray(summary.history) ? summary.history : []
      const total = Number(summary.totalRemainingCny), schedulable = Number(summary.schedulableRemainingCny)
      const known = summary.totalRemainingCny != null && Number.isFinite(total)
      $('#quota-total').textContent = known ? cny(total) : '—'
      $('#quota-schedulable').textContent = summary.schedulableRemainingCny == null ? '—' : cny(schedulable)
      $('#quota-consumed').textContent = summary.consumedCny == null ? '暂不可计算' : cny(summary.consumedCny)
      $('#quota-output').textContent = summary.apiAmountUsd == null ? '暂不可计算' : usdText(summary.apiAmountUsd, 3)
      const rollingCost = finiteChartValue(summary.realtimeCostCnyPerApiUsd)
      $('#quota-realtime-cost').textContent = rollingCost === null ? '暂不可计算' : `¥${number(rollingCost, 4)}/刀`
      const hours = summary.estimatedAvailableHours == null ? null : Number(summary.estimatedAvailableHours)
      $('#quota-estimated-hours').textContent = hours !== null && Number.isFinite(hours) ? (hours >= 24 ? `${number(hours / 24, 1)} 天` : `${number(hours, 1)} 小时`) : '暂不可估算'
      const latestPoint = points.at(-1) ?? {}
      const sampleSpeed = finiteChartValue(latestPoint.sampleApiAmountUsdPerHour)
      const rollingSpeed = finiteChartValue(latestPoint.rollingApiAmountUsdPerHour)
      const sampleCost = finiteChartValue(summary.sampleRealtimeCostCnyPerApiUsd)
      $('#quota-sample-speed').textContent = sampleSpeed === null ? '暂不可计算' : usdText(sampleSpeed, 2)
      $('#quota-rolling-speed').textContent = rollingSpeed === null ? '暂不可计算' : usdText(rollingSpeed, 2)
      $('#quota-sample-cost').textContent = sampleCost === null ? '暂不可计算' : `¥${number(sampleCost, 4)}/刀`
      const walletDistribution = Array.isArray(summary.walletDistribution) ? summary.walletDistribution : []
      renderDonut({
        ring: $('#quota-ring'), detail: $('#quota-ring-detail'), items: walletDistribution,
        center: known ? cny(total) : '—', centerLabel: '总余额', emptyDetail: '暂无可用余额明细',
        itemLabel: (item) => item.wallet,
        itemDetail: (item) => `${percent(item.ratio)} · ${cny(item.remainingCny)}${item.remainingUsd == null ? '' : ` · $${number(item.remainingUsd, 2)}`}${item.schedulable ? '' : ' · 不可调度'}`,
      })
      $('#quota-monitor-state').textContent = `${summary.sampledAt ? time(summary.sampledAt) : '尚无采样'} · ${number(summary.knownWallets)} 个已知 wallet${summary.warning ? ` · ${summary.warning}` : ''}`
      renderQuotaCharts(points)
    } catch (error) { $('#quota-monitor-state').textContent = `额度摘要读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const queryUsage = async (accountIds, onStatus = () => {}) => {
    const submitted = await requestJson('/api/upstreams/usage', {
      method: 'POST',
      headers: { 'Idempotency-Key': upstreamOperationId('upstream-usage') },
      body: JSON.stringify({ accountIds }),
    }, 20000)
    onStatus({ state: 'submitted', workflowId: submitted.workflowId, terminal: false })
    return await waitUpstreamJob(submitted.workflowId, onStatus)
  }
  const resetJobLog = (scope) => {
    $(`#upstream-${scope}-job`).textContent = 'JOB —'
    $(`#upstream-${scope}-logs`).innerHTML = '<li class="empty">等待提交</li>'
  }
  const appendJobLog = (scope, stage, message, state = 'running') => {
    const logs = $(`#upstream-${scope}-logs`)
    if (logs.querySelector('.empty')) logs.innerHTML = ''
    const item = document.createElement('li')
    item.dataset.state = state
    item.innerHTML = `<time>${escapeHtml(new Date().toLocaleTimeString('zh-CN', { hour12: false }))}</time><b>${escapeHtml(stage)}</b><span>${escapeHtml(message)}</span>`
    logs.append(item)
    logs.scrollTop = logs.scrollHeight
  }
  const jobStatusLogger = (scope) => (status) => {
    const state = String(status.state ?? 'unknown')
    const labels = { running: 'worker 正在执行运行面操作', completed: '作业完成，正在校验终态', failed: '作业执行失败', cancelled: '作业已取消', terminated: '作业已终止', timed_out: '作业执行超时' }
    appendJobLog(scope, 'workflow', labels[state] ?? `状态更新：${state}`, state === 'completed' ? 'done' : state === 'running' ? 'running' : 'failed')
  }
  try {
    await loadQuotaSummary()
    const options = await requestJson('/api/upstreams/options')
    upstreamGroupOptions = Array.isArray(options.groups) ? options.groups : []
    upstreamValuationPolicy = options.valuation ?? upstreamValuationPolicy
    const defaults = options.defaults ?? {}
    $('#upstream-create-priority').value = String(defaults.priority ?? 1)
    $('#upstream-create-capacity').value = String(defaults.capacity ?? 16)
    const defaultGroupIds = Array.isArray(defaults.groupIds) ? defaults.groupIds.map(Number) : [2, 3]
    $('#upstream-create-groups').innerHTML = upstreamGroupOptions.map((group) => `<label><input type="checkbox" value="${escapeHtml(group.id)}" ${defaultGroupIds.includes(Number(group.id)) ? 'checked' : ''}/><span>${escapeHtml(group.name)} <b>#${escapeHtml(group.id)}</b></span></label>`).join('')
  } catch (error) {
    $('#upstream-create-groups').innerHTML = `<span class="upstream-group-loading">号池选项读取失败：${escapeHtml(error instanceof Error ? error.message : String(error))}</span>`
  }
  const render = (data) => {
    const rows = Array.isArray(data.accounts) ? data.accounts : []
    lastUpstreamRows = rows
    lastUpstreamData = data
    $('#upstream-total').textContent = number(data.total)
    $('#upstream-available').textContent = `${number(data.availableTotal)} / ${number(data.total)}`
    $('#upstream-recharged').textContent = cny(data.rechargeTotalCny)
    $('#upstream-page-metric').textContent = `${number(data.page)} / ${number(data.totalPages)}`
    $('#upstream-query-state').textContent = data.search ? `筛选：${data.search} · 当前页 ${number(rows.length)} 条` : `当前页 ${number(rows.length)} 条 · 点击行编辑`
    $('#upstream-body').innerHTML = rows.length ? rows.map((row) => {
      const status = upstreamStatus(row)
      const usageResult = upstreamUsageById.get(Number(row.id))
      const usage = usageResult?.usage ?? {}
      const balance = upstreamBalancePresentation(usageResult)
      const multiplier = upstreamMultiplierPresentation(usageResult, row.rateCnyPerApiUsd)
      const manualRate = row.rateCnyPerApiUsd == null ? '—' : `¥${number(row.rateCnyPerApiUsd, 6)}`
      const detectedRate = multiplier.primary === '未知' ? '探测 —' : `探测 ${multiplier.primary}`
      return `<tr class="upstream-row" data-id="${escapeHtml(row.id)}" tabindex="0" role="button" aria-label="编辑 ${escapeHtml(row.name)}">
        <td class="upstream-id-cell"><b><a class="upstream-url-link" href="${escapeHtml(row.baseUrl)}" target="_blank" rel="noreferrer">${escapeHtml(row.name)}</a></b><small>#${escapeHtml(row.id)} · ${escapeHtml(row.baseUrl)}</small></td>
        <td class="upstream-muted">${escapeHtml(row.keyPrefix ?? '—')}</td>
        <td>${escapeHtml(row.suffix ?? '—')}</td>
        <td class="upstream-rate upstream-cost-cell" data-mismatch="${multiplier.mismatch}"><strong>${manualRate}</strong><small>${escapeHtml(detectedRate)}</small><small>${escapeHtml(multiplier.comparison)}</small></td>
        <td><span class="upstream-status ${status.className}">${status.label}</span><small class="upstream-muted">${escapeHtml(row.status || '—')}</small></td>
        <td class="upstream-balance" data-ok="${usageResult?.ok === true}" data-known="${balance.known}"><strong>${escapeHtml(balance.primary)}</strong><small>${escapeHtml(balance.secondary)}</small><small>${usageResult?.queriedAt ? time(usageResult.queriedAt) : '—'}</small></td>
        <td>${usage.totalTokens == null ? '—' : compact(usage.totalTokens)}<small class="upstream-muted">${usage.requestCount == null ? '—' : `${number(usage.requestCount)} 次`}</small></td>
        <td>${usage.actualCostUsd == null ? usage.costUsd == null ? '—' : usd(usage.costUsd) : usd(usage.actualCostUsd)}</td>
        <td><div class="upstream-groups">${upstreamGroupMarkup(row)}</div><small class="upstream-muted">Proxy #${escapeHtml(row.proxyId ?? '—')}</small></td>
        <td>${cny(row.rechargeCny)}<small class="upstream-muted">${number(row.rechargeCount)} 笔</small></td>
        <td class="upstream-muted">${time(row.updatedAt ?? row.createdAt)}</td>
      </tr>`
    }).join('') : '<tr><td colspan="11" class="empty">没有符合条件的 API-key 上游</td></tr>'
    renderPager('upstream', data)
  }
  const load = async () => {
    setState('读取中', 'refreshing')
    try {
      const query = new URLSearchParams({ page: String(upstreamPage) })
      if (upstreamSearch) query.set('search', upstreamSearch)
      const data = await requestJson(`/api/upstreams?${query}`)
      upstreamPage = Number(data.page ?? upstreamPage)
      render(data)
      const ids = lastUpstreamRows.map((row) => Number(row.id)).filter(Number.isSafeInteger)
      if (ids.length) {
        const cachedUsage = await requestJson(`/api/upstreams/usage-cache?accountIds=${ids.join(',')}`)
        for (const result of cachedUsage.results ?? []) upstreamUsageById.set(Number(result.accountId), result)
        render(data)
      }
      setState('已更新', 'ready')
      await loadQuotaSummary()
    } catch (error) {
      setState('读取失败', 'unavailable')
      $('#upstream-query-state').textContent = error instanceof Error ? error.message : String(error)
      $('#upstream-body').innerHTML = `<tr><td colspan="11" class="empty">${escapeHtml(error instanceof Error ? error.message : String(error))}</td></tr>`
    }
  }
  const openEdit = (row) => {
    activeUpstream = row
    editRechargeOperationId = upstreamOperationId(`upstream-recharge-${row.id}`)
    $('#upstream-edit-id').textContent = `#${row.id}`
    $('#upstream-edit-summary').textContent = `${row.name} · ${row.status === 'active' && row.schedulable ? '当前可调度' : '当前不可调度'} · 已充值 ${cny(row.rechargeCny)}`
    $('#upstream-edit-base-url').textContent = row.baseUrl
    $('#upstream-edit-key-prefix').textContent = `Key ${row.keyPrefix ?? '—'}`
    $('#upstream-edit-suffix').value = row.suffix ?? ''
    $('#upstream-edit-rate').value = row.rateCnyPerApiUsd ?? ''
    $('#upstream-edit-recharge').value = ''
    $('#upstream-edit-state').textContent = ''
    $('#upstream-edit-state').removeAttribute('data-state')
    resetJobLog('edit')
    const usageResult = upstreamUsageById.get(Number(row.id))
    $('#upstream-edit-usage-result').innerHTML = usageResult ? upstreamUsageMarkup(usageResult, row.rateCnyPerApiUsd) : '<p class="empty">尚未查询</p>'
    editDialog.showModal()
  }
  $('#upstream-usage-refresh-all').addEventListener('click', async () => {
    const button = $('#upstream-usage-refresh-all')
    button.disabled = true
    button.classList.add('is-loading')
    button.setAttribute('aria-busy', 'true')
    $('#upstream-usage-state').textContent = '正在提交全量刷新…'
    try {
      const result = await queryUsage([], (status) => {
        const state = String(status.state ?? 'unknown')
        if (state === 'submitted') {
          $('#upstream-usage-state').textContent = `已受理 ${status.workflowId} · 等待 worker`
        } else if (!status.terminal) {
          $('#upstream-usage-state').textContent = `worker ${state} · 后台刷新中…`
        } else {
          $('#upstream-usage-state').textContent = state === 'completed' ? '刷新完成，正在更新结果…' : `刷新${state}`
        }
      })
      for (const item of result.results ?? []) upstreamUsageById.set(Number(item.accountId), item)
      if (lastUpstreamData) render(lastUpstreamData)
      $('#upstream-usage-state').textContent = `全量 ${number(result.succeeded)} 成功 · ${number(result.failed)} 失败 · ${number(result.databaseQueries)} 次排队 DB 查询`
      await loadQuotaSummary()
    } catch (error) {
      $('#upstream-usage-state').textContent = error instanceof Error ? error.message : String(error)
    } finally {
      button.disabled = false
      button.classList.remove('is-loading')
      button.removeAttribute('aria-busy')
    }
  })
  $('#upstream-edit-usage').addEventListener('click', async () => {
    if (!activeUpstream) return
    const button = $('#upstream-edit-usage')
    button.disabled = true
    $('#upstream-edit-usage-result').innerHTML = '<p class="empty">正在查询…</p>'
    try {
      const result = await queryUsage([Number(activeUpstream.id)])
      for (const item of result.results ?? []) upstreamUsageById.set(Number(item.accountId), item)
      if (lastUpstreamData) render(lastUpstreamData)
      $('#upstream-edit-usage-result').innerHTML = result.results?.length ? upstreamUsageMarkup(result.results[0], activeUpstream.rateCnyPerApiUsd) : '<p class="empty">未找到可查询账号</p>'
    } catch (error) {
      $('#upstream-edit-usage-result').innerHTML = `<p class="empty">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`
    } finally { button.disabled = false }
  })
  const quotaRefreshInterval = $('#upstream-quota-refresh-interval')
  try {
    const stored = Number(localStorage.getItem(quotaRefreshStorageKey))
    if (oauthRefreshIntervals.has(stored)) quotaRefreshInterval.value = String(stored)
  } catch {
    // 隐私模式可能禁用存储，当前页面仍按默认间隔刷新。
  }
  quotaRefreshInterval.addEventListener('change', () => {
    try { localStorage.setItem(quotaRefreshStorageKey, quotaRefreshInterval.value) } catch { /* 当前页面继续生效。 */ }
    scheduleQuotaRefresh()
  })
  scheduleQuotaRefresh()
  $('#upstream-search-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    upstreamSearch = $('#upstream-search').value.trim()
    upstreamPage = 1
    await load()
  })
  let searchTimer = null
  $('#upstream-search').addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      upstreamSearch = $('#upstream-search').value.trim()
      upstreamPage = 1
      void load()
    }, 280)
  })
  $('#upstream-prev').addEventListener('click', async () => { upstreamPage -= 1; await load() })
  $('#upstream-next').addEventListener('click', async () => { upstreamPage += 1; await load() })
  $('#upstream-body').addEventListener('click', (event) => {
    if (event.target.closest('a')) return
    const row = event.target.closest('.upstream-row')
    if (!row) return
    const id = Number(row.dataset.id)
    const dataRow = lastUpstreamRows.find((item) => Number(item.id) === id)
    if (dataRow) openEdit(dataRow)
  })
  $('#upstream-body').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.target.click()
  })
  $('#upstream-create').addEventListener('click', () => {
    $('#upstream-create-state').textContent = '创建时将自动配置号池、Proxy #3、切号模板，以及账号专属私有探活分组和 API Key。'
    $('#upstream-create-state').removeAttribute('data-state')
    createOperationId = upstreamOperationId('upstream-create')
    resetJobLog('create')
    createDialog.showModal()
  })
  createDialog.addEventListener('close', () => {
    $('#upstream-create-api-key').value = ''
    createOperationId = null
  })
  $('#upstream-create-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const button = $('#upstream-create-submit')
    button.disabled = true
    $('#upstream-create-state').textContent = '作业已提交，Temporal worker 正在创建并绑定分组，API key 不会回显…'
    appendJobLog('create', 'request', '正在提交创建请求，API key 不会写入日志')
    try {
      const operation = createOperationId ?? (createOperationId = upstreamOperationId('upstream-create'))
      const rechargeValue = $('#upstream-create-recharge').value.trim()
      const groupIds = [...document.querySelectorAll('#upstream-create-groups input:checked')].map((input) => Number(input.value))
      if (groupIds.length === 0) throw new Error('至少选择一个号池')
      const submitted = await requestJson('/api/upstreams', {
        method: 'POST',
        headers: { 'Idempotency-Key': operation },
        body: JSON.stringify({
          baseUrl: $('#upstream-create-base-url').value,
          apiKey: $('#upstream-create-api-key').value,
          suffix: $('#upstream-create-suffix').value,
          rateCnyPerApiUsd: Number($('#upstream-create-rate').value),
          priority: Number($('#upstream-create-priority').value),
          capacity: Number($('#upstream-create-capacity').value),
          groupIds,
          rechargeCny: rechargeValue ? Number(rechargeValue) : undefined,
          operationId: operation,
        }),
      }, 20000)
      $('#upstream-create-job').textContent = `JOB ${submitted.workflowId}`
      appendJobLog('create', 'accepted', `Temporal 已接受作业 ${submitted.workflowId}`)
      const result = await waitUpstreamJob(submitted.workflowId, jobStatusLogger('create'))
      appendJobLog('create', 'verify', `运行面回读账号 #${result.account?.id ?? '—'}，费率 ${result.account?.rateCnyPerApiUsd ?? '—'}`, 'done')
      if (result.accounting?.mutation) appendJobLog('create', 'accounting', `人民币采购成本已记账 ${cny(result.accounting.amountCny)}`, 'done')
      appendJobLog('create', 'done', '创建、分组绑定和终态校验完成', 'done')
      $('#upstream-create-state').textContent = `创建成功：账号 #${result.account?.id ?? '—'}${result.accounting?.mutation ? `，已记账 ${cny(result.accounting.amountCny)}` : ''}`
      $('#upstream-create-state').dataset.state = 'success'
      $('#upstream-create-api-key').value = ''
      createOperationId = null
      await load()
      setTimeout(() => { if (createDialog.open) createDialog.close() }, 350)
    } catch (error) {
      $('#upstream-create-state').textContent = error instanceof Error ? error.message : String(error)
      $('#upstream-create-state').dataset.state = 'error'
      appendJobLog('create', 'failed', error instanceof Error ? error.message : String(error), 'failed')
    } finally { button.disabled = false }
  })
  $('#upstream-edit-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!activeUpstream) return
    const button = $('#upstream-edit-submit')
    button.disabled = true
    $('#upstream-edit-state').textContent = '正在保存调整…'
    $('#upstream-edit-state').removeAttribute('data-state')
    resetJobLog('edit')
    appendJobLog('edit', 'request', `正在提交账号 #${activeUpstream.id} 调整`)
    try {
      const id = Number(activeUpstream.id)
      const submittedUpdate = await requestJson(`/api/upstreams/${id}`, {
        method: 'PATCH',
        headers: { 'Idempotency-Key': upstreamOperationId(`upstream-update-${id}`) },
        body: JSON.stringify({ suffix: $('#upstream-edit-suffix').value, rateCnyPerApiUsd: Number($('#upstream-edit-rate').value) }),
      })
      $('#upstream-edit-job').textContent = `JOB ${submittedUpdate.workflowId}`
      appendJobLog('edit', 'accepted', `Temporal 已接受调整作业 ${submittedUpdate.workflowId}`)
      const updated = await waitUpstreamJob(submittedUpdate.workflowId, jobStatusLogger('edit'))
      appendJobLog('edit', 'verify', `运行面回读费率 ${updated.account?.rateCnyPerApiUsd ?? '—'}，后缀 ${updated.account?.suffix ?? '—'}`, 'done')
      const rechargeValue = $('#upstream-edit-recharge').value.trim()
      let recharge = null
      if (rechargeValue) {
        const submittedRecharge = await requestJson(`/api/upstreams/${id}/recharge`, {
          method: 'POST',
          headers: { 'Idempotency-Key': editRechargeOperationId ?? upstreamOperationId(`upstream-recharge-${id}`) },
          body: JSON.stringify({ amountCny: Number(rechargeValue) }),
        }, 20000)
        recharge = await waitUpstreamJob(submittedRecharge.workflowId)
        appendJobLog('edit', 'accounting', `追加充值已记账 ${cny(recharge.accounting?.amountCny ?? recharge.amountCny)}`, 'done')
      }
      appendJobLog('edit', 'done', '调整和终态校验完成', 'done')
      $('#upstream-edit-state').textContent = recharge?.recovered ? '调整与充值完成，已恢复调度。' : '调整完成。'
      $('#upstream-edit-state').dataset.state = 'success'
      editRechargeOperationId = null
      await load()
      setTimeout(() => { if (editDialog.open) editDialog.close() }, 350)
    } catch (error) {
      $('#upstream-edit-state').textContent = error instanceof Error ? error.message : String(error)
      $('#upstream-edit-state').dataset.state = 'error'
      appendJobLog('edit', 'failed', error instanceof Error ? error.message : String(error), 'failed')
    } finally { button.disabled = false }
  })
  await load()
  if (route.get('action') === 'create') {
    $('#upstream-create').click()
  }
}

async function boot() {
  if (page === 'login') return await loginPage()
  shell()
  if (page === 'scores') return await scoresPage()
  if (page === 'ranking') return await rankingPage()
  if (page === 'lottery') return await lotteryPage()
  if (page === 'operations') return await operationsPage()
  if (page === 'oauth-cost') return await oauthCostPage()
  if (page === 'account-import') return await accountImportPage()
  if (page === 'upstreams') return await upstreamsPage()
}

boot().catch((error) => {
  const target = $('.workspace') ?? $('main')
  if (target) target.insertAdjacentHTML('afterbegin', `<div class="fatal-state">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`)
})
