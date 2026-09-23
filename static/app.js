import { scoreFreshnessLabel, shouldApplyScorePayload } from './score-display-freshness.js'
import { sampleTimeDisplay } from './sample-time.js'
import { buildSupplierQualityAssets } from './upstream-quality-assets.js'
import { bindHistoryChartTooltip, finiteChartValue, historyChartMarkup } from './history-chart.js'

const page = document.body.dataset.page
export const $ = (selector) => document.querySelector(selector)

export function escapeHtml(value) {
  const node = document.createElement('span')
  node.textContent = String(value ?? '')
  return node.innerHTML
}

export function number(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}
export function duration(value) { return Number.isFinite(Number(value)) ? `${number(Number(value) / 1000, 1)}s` : '—' }

export function usd(value, digits = 3) {
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

export function compact(value) {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(Number(value))
}

export function percent(value) {
  return value === null || value === undefined ? '—' : `${number(Number(value) * 100, 1)}%`
}

export function time(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value))
}

export async function requestJson(url, options = {}, timeoutMs = 20000) {
  const refresh = options.refresh === true
  const { refresh: _refresh, ...fetchOptions } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(refresh ? { 'x-api2business-refresh': '1' } : {}),
        ...(fetchOptions.headers ?? {}),
      },
    })
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

async function loadScoreData() {
  return await requestJson('/api/scores')
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
    ['bugteam-cost', '/bugteam-cost', 'BugTeam 实时成本'],
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
let latestQuotaSummary = null
let scoreSnapshotLoaded = false
let upstreamAssetsLoaded = false
let poolQualityInFlight = null
let poolErrorPage = 1
const poolErrorPageSize = 20
let poolErrorInFlight = null

let externalCutoffRows = []
let externalCutoffPage = 1
const externalCutoffPageSize = 10

export function renderExternalCutoffLogs() {
  const body = $('#external-cutoff-log-body')
  if (!body) return
  const rows = externalCutoffRows.slice().reverse()
  const pageCount = Math.max(1, Math.ceil(rows.length / externalCutoffPageSize))
  externalCutoffPage = Math.min(Math.max(1, externalCutoffPage), pageCount)
  const pageRows = rows.slice((externalCutoffPage - 1) * externalCutoffPageSize, externalCutoffPage * externalCutoffPageSize)
  const prev = $('#external-cutoff-prev'); const next = $('#external-cutoff-next'); const page = $('#external-cutoff-page')
  if (page) page.textContent = `${externalCutoffPage} / ${pageCount}`
  if (prev) prev.disabled = externalCutoffPage <= 1
  if (next) next.disabled = externalCutoffPage >= pageCount
  body.innerHTML = pageRows.length ? pageRows.map((row) => `<tr><td>${escapeHtml(time(row.occurredAt))}</td><td>${escapeHtml(row.accountIds?.length ? row.accountIds.map((id) => `#${id}`).join(', ') : '全量')}</td><td>${row.action === 'restore' ? '恢复' : '切断'}</td><td>${escapeHtml(row.mode ?? 'live')}</td><td>${number(row.beforeCount)}</td><td>${number(row.afterCount)}</td><td>${escapeHtml(row.action === 'restore' ? `外部断流 · ${row.restoreReason ?? '自动恢复'}` : `外部断流 · 计划 ${number(row.durationSeconds)} 秒`)}</td><td>${escapeHtml(row.action === 'restore' ? `成功 · 恢复 ${number(row.afterCount)} 个` : '成功')}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">暂无外部切断记录</td></tr>'
  body.dataset.loaded = 'true'
}

export async function loadExternalCutoffHistory() {
  const body = $('#external-cutoff-log-body')
  try {
    const data = await requestJson('/api/oauth/api-key-cutoff/history')
    externalCutoffRows = (data.events ?? []).filter((row) => row.trigger === 'external-error')
    renderExternalCutoffLogs()
  } catch (error) {
    if (body) {
      body.innerHTML = `<tr><td colspan="8" class="empty">外部切断记录读取失败：${escapeHtml(error instanceof Error ? error.message : String(error))}</td></tr>`
      body.dataset.loaded = 'error'
    }
    throw error
  }
}

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
  renderScoreFreshness()
  renderScoreRefreshCountdown()
}

function renderScoreFreshness() {
  const relative = $('#score-updated-time')
  const exact = $('#score-updated-exact')
  if (relative) relative.textContent = scoreFreshnessLabel(scoreRefreshedAt)
  if (exact) exact.textContent = scoreRefreshedAt ? `最近快照：北京时间 ${time(scoreRefreshedAt)}` : '最近快照：尚无成功时间'
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
      loadUnifiedUpstreamAssets(true),
      readUsageCache(scoreRows.map((row) => row.accountId)),
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
  const rateBase = upstream?.baseUrl || usageResult?.baseUrl || ''
  const walletRate = rateBase ? upstreamWalletCnyRate(rateBase) : 1
  const balanceCny = remainingUsd !== null && Number.isFinite(remainingUsd) ? Math.max(0, remainingUsd) * walletRate : null
  const probe = usageResult?.billingMultiplier ?? {}
  const probeCost = probe.value != null && Number.isFinite(Number(probe.value)) && Number(probe.value) > 0
    ? Number(probe.value) * walletRate
    : null
  return { upstream, usageResult, balanceCny, probeCost }
}

export function displayAccountName(value, baseUrl = '') {
  const raw = String(value ?? '').trim()
  if (!raw) return '—'
  const normalizedBaseUrl = String(baseUrl ?? '').trim().replace(/\/+$/u, '')
  const rateSuffix = /\s+\d+(?:\.\d{1,6})?$/u
  if (normalizedBaseUrl && raw.startsWith(`${normalizedBaseUrl} `)) {
    const rest = raw.slice(normalizedBaseUrl.length).trim().replace(rateSuffix, '').trim()
    return rest ? `${normalizedBaseUrl} ${rest}` : normalizedBaseUrl
  }
  return /^https?:\/\/\S+\s+\S+\s+\d+(?:\.\d{1,6})?$/u.test(raw) ? raw.replace(rateSuffix, '').trim() : raw
}

function scoreAccountDisplayName(row, upstream) {
  if (upstream?.baseUrl && upstream?.suffix) return `${upstream.baseUrl} ${upstream.suffix}`
  return displayAccountName(row.accountName)
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
    cost: probeCost ?? upstream?.rateCnyPerApiUsd ?? usage.costRateCnyPerApiUsd,
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
  const monitorAccount = data.monitorAccount ?? {}
  const rawBalance = monitorAccount.balanceUsd
  const balance = rawBalance === null || rawBalance === undefined ? null : Number(rawBalance)
  const hasBalance = balance !== null && Number.isFinite(balance)
  const balanceLabel = hasBalance ? `$${balance.toFixed(2)}` : '—'
  const balanceStatus = monitorAccount.status === 'available' && hasBalance
    ? '可用'
    : monitorAccount.status === 'depleted' && hasBalance
      ? '已耗尽'
      : '暂不可用'
  const balanceNode = $('#idle-probe-rolling')
  balanceNode.dataset.balanceStatus = balanceStatus
  balanceNode.textContent = `探活 24h：${number(rolling.requestAttempts)} 次 · ${usdText(rolling.consumedApiAmountUsd, 4)} · ${number(rolling.sampledAccounts)} 个账号${rolling.latestSampleAt ? ` · 最近 ${time(rolling.latestSampleAt)}` : ''} · 余额 ${balanceLabel}（${balanceStatus}）${monitorAccount.queriedAt ? ` · 查询 ${time(monitorAccount.queriedAt)}` : ''}`
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
    const manualCost = upstream?.rateCnyPerApiUsd ?? costRate
    const effectiveCost = probeCost ?? manualCost
    const costSource = probeCost !== null ? '探测' : effectiveCost == null ? '成本未知' : '手工'
    const desiredLabel = desiredPriority === null ? number(row.priority) : `${number(row.priority)} → ${number(desiredPriority)}`
    const status = upstream ? upstreamStatus(upstream) : { label: available ? '可调度' : '不可用', className: available ? 'is-available' : 'is-error' }
    const latestSample = sampleTimeDisplay(row.latestSampleAt)
    return `<tr class="${available ? '' : 'score-row-unavailable'}">
      <td class="account-cell"><b>${escapeHtml(scoreAccountDisplayName(row, upstream))}</b><small>#${escapeHtml(row.accountId)}</small></td>
      <td><span class="upstream-status ${status.className}">${status.label}</span><small class="upstream-muted">${escapeHtml(reason.label ?? upstream?.status ?? '—')}</small></td>
      <td><span class="score-value ${gradeClass(row.grade)}">${number(row.score, 1)}</span><small class="upstream-muted">${escapeHtml(row.grade ?? '—')} · ${escapeHtml(row.confidence ?? '—')}</small></td>
      <td>${desiredLabel}<small class="upstream-muted">${priorityDelta === null ? '当前' : `变化 ${signed(priorityDelta)}`}</small></td>
      <td class="upstream-balance" data-known="${balanceCny !== null}"><strong>${balanceCny === null ? '未查询' : cny(balanceCny)}</strong><small>${usageResult?.queriedAt ? time(usageResult.queriedAt) : '无额度样本'}</small></td>
      <td class="upstream-rate upstream-cost-cell"><strong>${effectiveCost == null ? '—' : `¥${number(effectiveCost, 4)}`}</strong><small>${escapeHtml(costSource)}</small></td>
      <td class="usd-cell">${usd(usage.apiAmountUsd)}<small class="upstream-muted">${compact(usage.requestCount)} 请求</small></td>
      <td class="sample-time sample-time-${latestSample.freshness}"${latestSample.exact ? ` title="北京时间 ${escapeHtml(latestSample.exact)}"` : ''}><span>${escapeHtml(latestSample.label)}</span></td>
      <td>${percent(row.failureRate)}<small class="upstream-muted">${number(row.attemptCount ?? row.selectedCalls ?? row.observedAttempts)} 次尝试</small></td>
      <td>${row.ttftP95Ms == null ? '—' : `${number(row.ttftP95Ms)} ms`}</td>
      <td class="failover-cell" title="失败 ${number(row.failureRequests)} 次；触发切号 ${number(row.failoverRequests)} 次，其中恢复 ${number(row.failoverRecovered)} 次；未触发切号 ${number(row.failoverNotTriggered)} 次">
        <span>${number(row.failureRequests)} / ${number(row.failoverRequests)} / ${number(row.failoverRecovered)}</span>
        <small>未触发 ${number(row.failoverNotTriggered)}</small>
      </td>
      <td>${groupLabels(row)}</td>
      <td>${upstream ? `<div class="table-row-actions"><button class="icon-command benchmark-trigger${scoreBenchmarksById.get(Number(row.accountId))?.state === 'running' ? ' is-running' : ''}" type="button" data-score-benchmark="${escapeHtml(row.accountId)}" title="智商评测" aria-label="智商评测"><span>⌁</span></button><button class="text-command table-action" type="button" data-score-upstream-edit="${escapeHtml(row.accountId)}">调整</button></div>${scoreBenchmarksById.has(Number(row.accountId)) ? `<small class="benchmark-inline">${scoreBenchmarksById.get(Number(row.accountId)).state === 'running' ? '评测中' : `智商 ${scoreBenchmarksById.get(Number(row.accountId)).score == null ? '—' : number(scoreBenchmarksById.get(Number(row.accountId)).score, 1)}`} · ${escapeHtml(scoreBenchmarksById.get(Number(row.accountId)).state)}</small>` : ''}` : '—'}</td>
    </tr>`
  }).join('') : '<tr><td colspan="13" class="empty">没有匹配的账号</td></tr>'
  const range = filteredRows.length === 0 ? '0 条' : `${start + 1}-${Math.min(start + scorePageSize, filteredRows.length)} / ${number(filteredRows.length)} 条`
  $('#score-page').textContent = `${scorePage} / ${totalPages} · ${range}`
  $('#score-prev').disabled = scorePage <= 1
  $('#score-next').disabled = scorePage >= totalPages
  document.querySelectorAll('[data-score-sort]').forEach((header) => {
    const selected = header.dataset.scoreSort === scoreSort.key
    header.setAttribute('aria-sort', selected ? (scoreSort.direction === 'asc' ? 'ascending' : 'descending') : 'none')
  })
}

function resetScoreTableViewport() {
  const wrap = document.querySelector('.score-table-wrap')
  if (wrap) wrap.scrollLeft = 0
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
  scoreSnapshotLoaded = true
  renderScoreMetrics(data)
  const status = data.status ?? (scoreRows.length ? 'ready' : 'unavailable')
  $('#score-state').textContent = ({ ready: '已更新', refreshing: '刷新中', stale: '使用旧快照', unavailable: '暂无快照' })[status] ?? status
  $('#score-state').dataset.state = status
  scoreRefreshedAt = data.refreshedAt ?? data.queryCompletedAt ?? data.collectedAt ?? scoreRefreshedAt
  scoreNextRefreshAt = data.nextRefreshAt ?? scoreNextRefreshAt
  if (data.recentCallLimit && $('#score-call-limit')) $('#score-call-limit').value = String(data.recentCallLimit)
  renderRefreshClock()
  renderScoreRows()
  renderSupplierQualityAssets()
  return true
}

async function readUsageCache(accountIds) {
  const ids = [...new Set((accountIds ?? []).map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0))]
  if (!ids.length) return
  const options = await requestJson('/api/upstreams/options').catch(() => null)
  if (options?.valuation) applyUpstreamValuationPolicy(options.valuation)
  const batches = []
  for (let offset = 0; offset < ids.length; offset += 40) batches.push(ids.slice(offset, offset + 40))
  const cachedPages = await Promise.all(batches.map((batch) => requestJson(`/api/upstreams/usage-cache?accountIds=${batch.join(',')}`)))
  for (const result of cachedPages.flatMap((cached) => cached.results ?? [])) {
    const id = Number(result?.accountId)
    if (Number.isSafeInteger(id)) scoreUsageById.set(id, result)
  }
  if (scoreSnapshotLoaded) renderScoreRows()
}

async function loadUnifiedUpstreamAssets(refresh = false) {
  if (upstreamAssetsInFlight !== null) return await upstreamAssetsInFlight
  const cache = refresh ? { refresh: true } : {}
  upstreamAssetsInFlight = (async () => {
    const [first, options, benchmarks] = await Promise.all([
      requestJson('/api/upstreams?page=1', cache),
      requestJson('/api/upstreams/options', cache),
      requestJson('/api/upstreams/benchmarks', cache),
    ])
    applyUpstreamValuationPolicy(options.valuation)
    scoreBenchmarkOptions = options.benchmark ?? scoreBenchmarkOptions
    scoreBenchmarksById = new Map((benchmarks.results ?? []).map((row) => [Number(row.accountId), row]))
    const pageCount = Math.max(1, Number(first.totalPages ?? 1))
    const rest = pageCount > 1
      ? await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) => requestJson(`/api/upstreams?page=${index + 2}`, cache)))
      : []
    const accounts = [first, ...rest].flatMap((pageData) => pageData.accounts ?? [])
    scoreUpstreamsById = new Map(accounts.map((row) => [Number(row.id), row]))
    upstreamAssetsLoaded = true
    await readUsageCache(accounts.map((row) => row.id))
    renderScoreRows()
    renderSupplierQualityAssets()
  })()
  try { return await upstreamAssetsInFlight } finally { upstreamAssetsInFlight = null }
}

async function loadUnifiedQuotaSummary() {
  if (quotaSummaryInFlight !== null) return await quotaSummaryInFlight
  quotaSummaryInFlight = requestJson('/api/upstreams/quota-summary').then(renderUnifiedQuotaSummary)
  try { return await quotaSummaryInFlight } finally { quotaSummaryInFlight = null }
}

function renderUnifiedQuotaSummary(summary) {
  latestQuotaSummary = summary
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
  renderSupplierQualityAssets()
}

const poolParticipationColors = ['#afdd4a', '#78b8de', '#d6a94d', '#d77b70', '#9ba7d7', '#74c7a1', '#d49ad2', '#b6a37c']

export function renderDonut({ ring, detail, items, center, centerLabel, emptyDetail, itemLabel, itemDetail, itemColor }) {
  const normalized = items.filter((item) => Number(item.ratio) > 0)
  let angle = 0
  const stops = normalized.map((item, index) => {
    const start = angle
    angle += Number(item.ratio) * 360
    const color = itemColor?.(item, index) ?? poolParticipationColors[index % poolParticipationColors.length]
    return `${color} ${start}deg ${angle}deg`
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

const supplierQualityColors = {
  good: 'var(--signal)',
  mid: 'var(--warning)',
  risk: 'var(--line)',
}

const supplierQualityLabels = {
  good: '优质',
  mid: '一般',
  risk: '不良',
}

function availabilityDuration(value) {
  const hours = Number(value)
  if (!Number.isFinite(hours)) return '暂不可估算'
  return hours >= 24 ? `${number(hours / 24, 1)} 天` : `${number(hours, 1)} 小时`
}

function renderSupplierQualityAssets() {
  const ring = $('#supplier-quality-ring')
  if (!ring) return
  if (!latestQuotaSummary || !scoreSnapshotLoaded || !upstreamAssetsLoaded) {
    ring.innerHTML = '<strong>—</strong><small>等待快照</small>'
    $('#quota-quality-estimated-hours').textContent = '等待数据'
    $('#quota-quality-balance').textContent = '评分 >80 · 等待评分与额度快照'
    return
  }
  const quality = buildSupplierQualityAssets({
    walletDistribution: latestQuotaSummary.walletDistribution,
    scoreRows,
    upstreamAccounts: [...scoreUpstreamsById.values()],
    consumedCny: latestQuotaSummary.consumedCny,
    burnWindowHours: latestQuotaSummary.burnWindowHours,
  })
  renderDonut({
    ring,
    detail: $('#supplier-quality-detail'),
    items: quality.qualityBands,
    center: cny(quality.goodBalanceCny),
    centerLabel: quality.goodBalanceRatio === null ? '优质余额' : `优质 ${percent(quality.goodBalanceRatio)}`,
    emptyDetail: '暂无可计算的供应商余额',
    itemColor: (item) => supplierQualityColors[item.band] ?? supplierQualityColors.risk,
    itemLabel: (item) => supplierQualityLabels[item.band] ?? '不良',
    itemDetail: (item) => `${cny(item.remainingCny)} · ${percent(item.ratio)} · ${number(item.supplierCount)} 个供应商`,
  })
  $('#quota-quality-estimated-hours').textContent = availabilityDuration(quality.estimatedGoodAvailableHours)
  $('#quota-quality-balance').textContent = `评分 >80 · 优质余额 ${cny(quality.goodBalanceCny)} · ${number(quality.scoredWallets)} 个已评分${quality.unknownScoreWallets > 0 ? ` · ${number(quality.unknownScoreWallets)} 个未知` : ''}`
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
  $('#pool-quality-outcomes').textContent = `${number(data.rawSuccessRequests ?? data.successRequests)} / ${number(data.rawFailureRequests ?? data.failureRequests)}`
  $('#pool-quality-failure-rate').textContent = `失败率 ${data.failureRate == null ? '—' : percent(data.failureRate)}`
  $('#pool-quality-failover').textContent = `${number(data.rawFailoverRecovered ?? data.failoverRecovered)} / ${number(data.rawFailoverRequests ?? data.failoverRequests)}`
  $('#pool-quality-ttft').textContent = data.ttftP95Ms == null ? '—' : `${number(data.ttftP95Ms)} ms`
  $('#pool-quality-ttft-samples').textContent = `首 token 样本 ${number(data.rawFirstTokenSamples ?? data.firstTokenSamples)}`
  $('#pool-quality-chart').innerHTML = historyChartMarkup(data.history ?? [], {
    series: [
      { key: 'score', className: 'chart-pool-quality', label: '当前采样' },
      { key: 'rollingScore', className: 'chart-pool-quality-rolling', label: '100 点滚动' },
    ],
    valueFormatter: (value) => number(value, 1), unit: '质量分 / 100', ariaLabel: '混池和自用池综合质量评分', yMin: 0, yMax: 100,
  })
  bindHistoryChartTooltip($('#pool-quality-chart'))
  const participation = Array.isArray(data.participation) ? data.participation : []
  const ring = $('#pool-participation-ring')
  renderDonut({
    ring, detail: $('#pool-participation-detail'), items: participation,
    center: number(data.rawCallCount || data.participationAttempts || data.observedAttempts), centerLabel: '调用', emptyDetail: '暂无参与样本',
    itemLabel: (item) => displayAccountName(item.accountName ?? item.wallet, item.baseUrl) || `账号 #${item.accountId}`,
    itemDetail: (item) => `${percent(item.ratio)} · ${number(item.rawAttempts ?? item.attempts)} 次 · ${item.costRateCnyPerApiUsd == null ? '成本未知' : `¥${number(item.costRateCnyPerApiUsd, 4)}/刀 ${item.costSource === 'detected' ? '探测' : '手工'}`}`,
  })
  $('#pool-participation-legend').innerHTML = participation.length ? participation.map((item, index) => {
    const label = displayAccountName(item.accountName ?? item.wallet, item.baseUrl) || `账号 #${item.accountId}`
    const cost = item.costRateCnyPerApiUsd == null ? '成本未知' : `¥${number(item.costRateCnyPerApiUsd, 4)}/刀`
    const source = item.costSource === 'detected' ? '探测' : item.costSource === 'manual' ? '手工' : ''
    return `<li><i style="--participation-color:${poolParticipationColors[index % poolParticipationColors.length]}"></i><span title="${escapeHtml(label)}"><b>${escapeHtml(label)}</b><em>${escapeHtml(cost)}${source ? ` · ${source}` : ''}</em></span><strong>${percent(item.ratio)}</strong><small>${number(item.rawAttempts ?? item.attempts)} 次</small></li>`
  }).join('') : '<li class="empty">暂无参与样本</li>'
}

async function loadPoolQuality() {
  if (poolQualityInFlight !== null) return await poolQualityInFlight
  poolQualityInFlight = requestJson('/api/upstreams/pool-quality').then(renderPoolQuality)
  try { return await poolQualityInFlight } finally { poolQualityInFlight = null }
}

function poolErrorMessage(row) {
  return row.upstreamErrorMessage || row.errorMessage || row.upstreamErrorDetail || '无错误正文'
}

function renderPoolQualityErrors(data) {
  const rows = Array.isArray(data.rows) ? data.rows : []
  const pagination = data.pagination ?? { page: 1, totalPages: 1, total: 0 }
  poolErrorPage = Number(pagination.page ?? 1)
  const filterLabel = ({ scoreable: '计分失败', excluded: '已排除', all: '全部错误' })[data.filter] ?? data.filter
  $('#pool-error-state').textContent = `${time(data.sampledAt)} 采样 · 最近 ${number(data.recentCallLimit)} 次调用 · ${filterLabel} ${number(pagination.total)} 条`
  const models = Array.isArray(data.modelDistribution) ? data.modelDistribution : []
  $('#pool-error-models').textContent = models.length
    ? `模型分布：${models.map((item) => `${item.model || 'unknown'} ${number(item.count)}`).join(' · ')}`
    : '模型分布：当前口径无错误'
  $('#pool-error-body').innerHTML = rows.length ? rows.map((row, index) => {
    const message = poolErrorMessage(row)
    const requestId = String(row.requestId ?? '—')
    const endpoint = `${row.inboundEndpoint ?? '—'} → ${row.upstreamEndpoint ?? '—'}`
    const detail = [
      ['请求 ID', requestId],
      ['模型', `${row.model ?? 'unknown'}${row.upstreamModel && row.upstreamModel !== row.model ? ` → ${row.upstreamModel}` : ''}`],
      ['用户', `${row.userEmail ?? '未知用户'}${row.userId == null ? '' : ` #${row.userId}`}`],
      ['账号', `${displayAccountName(row.accountName, row.baseUrl)} #${row.accountId ?? '—'}`],
      ['状态', `记录 ${row.clientStatusCode ?? '—'} / 上游 ${row.upstreamStatusCode ?? '—'}`],
      ['端点', endpoint],
      ['分类', row.scoreable ? '计分失败' : `已排除 · ${row.exclusionReason ?? '未分类'}`],
      ['错误类型', `${row.errorPhase ?? '—'} / ${row.errorType ?? '—'}`],
      ['对外错误', row.errorMessage ?? '—'],
      ['上游错误', row.upstreamErrorMessage ?? '—'],
      ['上游详情', row.upstreamErrorDetail ?? '—'],
    ]
    return `<tr class="pool-error-row" data-pool-error-row="${index}" tabindex="0" aria-expanded="false"><td><time>${time(row.createdAt)}</time></td><td class="pool-error-model"><b>${escapeHtml(row.model ?? 'unknown')}</b>${row.upstreamModel && row.upstreamModel !== row.model ? `<small>→ ${escapeHtml(row.upstreamModel)}</small>` : ''}</td><td class="account-cell pool-error-user"><b>${escapeHtml(row.userEmail ?? '未知用户')}</b><small>${row.userId == null ? '未记录 ID' : `#${number(row.userId)}`}</small></td><td class="account-cell"><b>${escapeHtml(displayAccountName(row.accountName, row.baseUrl))}</b><small>#${number(row.accountId)}</small></td><td class="pool-error-status"><b>${escapeHtml(row.clientStatusCode ?? '—')}</b><span>/</span><b>${escapeHtml(row.upstreamStatusCode ?? '—')}</b></td><td class="pool-error-endpoint">${escapeHtml(endpoint)}</td><td>${row.stream ? '流式' : '同步'}${row.failoverTriggered ? '<small class="pool-error-failover">触发切号</small>' : ''}</td><td class="pool-error-summary" title="${escapeHtml(message)}">${escapeHtml(message)}</td></tr><tr class="pool-error-detail" data-pool-error-detail="${index}" hidden><td colspan="8"><dl>${detail.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl></td></tr>`
  }).join('') : '<tr><td colspan="8" class="empty">当前口径没有错误记录</td></tr>'
  $('#pool-error-page').textContent = `${number(pagination.page)} / ${number(pagination.totalPages)} · ${number(pagination.total)} 条`
  $('#pool-error-prev').disabled = pagination.page <= 1
  $('#pool-error-next').disabled = pagination.page >= pagination.totalPages
  document.querySelectorAll('[data-pool-error-row]').forEach((row) => {
    const toggle = () => {
      const detail = document.querySelector(`[data-pool-error-detail="${row.dataset.poolErrorRow}"]`)
      const expanded = row.getAttribute('aria-expanded') !== 'true'
      row.setAttribute('aria-expanded', String(expanded))
      detail.hidden = !expanded
    }
    row.addEventListener('click', toggle)
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle() }
    })
  })
}

async function loadPoolQualityErrors() {
  if (poolErrorInFlight !== null) return await poolErrorInFlight
  const button = $('#refresh-pool-errors')
  const filter = $('#pool-error-filter').value
  button.disabled = true
  button.classList.add('is-loading')
  $('#pool-error-state').textContent = '正在通过单连接队列读取错误证据…'
  poolErrorInFlight = requestJson(`/api/upstreams/pool-quality/errors?page=${poolErrorPage}&pageSize=${poolErrorPageSize}&filter=${encodeURIComponent(filter)}`, {}, 60000).then(renderPoolQualityErrors)
  try { return await poolErrorInFlight }
  catch (error) {
    $('#pool-error-state').textContent = `错误记录读取失败：${error instanceof Error ? error.message : String(error)}`
    throw error
  } finally {
    poolErrorInFlight = null
    button.disabled = false
    button.classList.remove('is-loading')
  }
}

async function scoresPage() {
  resetScoreTableViewport()
  void loadExternalCutoffHistory().catch(() => null)
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
  $('#pool-error-filter').addEventListener('change', () => { poolErrorPage = 1; void loadPoolQualityErrors() })
  $('#refresh-pool-errors').addEventListener('click', () => void loadPoolQualityErrors())
  $('#pool-error-prev').addEventListener('click', () => { poolErrorPage = Math.max(1, poolErrorPage - 1); void loadPoolQualityErrors() })
  $('#pool-error-next').addEventListener('click', () => { poolErrorPage += 1; void loadPoolQualityErrors() })
  $('#external-cutoff-prev').addEventListener('click', () => { externalCutoffPage = Math.max(1, externalCutoffPage - 1); renderExternalCutoffLogs() })
  $('#external-cutoff-next').addEventListener('click', () => { externalCutoffPage += 1; renderExternalCutoffLogs() })
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
    $('#score-upstream-create-state').textContent = '创建时将自动配置号池、直连（无账号级 Proxy）、切号模板，以及账号专属私有探活分组和 API Key。'
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
      await loadUnifiedUpstreamAssets(true)
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
    $('#score-upstream-edit-summary').textContent = `${displayAccountName(row.name, row.baseUrl)} · ${row.status === 'active' && row.schedulable ? '当前可调度' : '当前不可调度'} · 已充值 ${cny(row.rechargeCny)}`
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
      $('#score-benchmark-summary').textContent = `${displayAccountName(row.name, row.baseUrl)} · ${row.baseUrl} · ${scoreBenchmarkOptions?.provider ?? 'apitest.work compatible'}`
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
      await loadUnifiedUpstreamAssets(true)
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
    loadUnifiedUpstreamAssets(true),
    readUsageCache(scoreRows.map((row) => row.accountId)),
    loadUnifiedQuotaSummary(),
    loadPoolQuality(),
    loadPoolQualityErrors(),
    loadIdleProbeRollingUsage(),
    loadPriorityHistory(),
    loadIdleProbeHistory(),
  ]))
  $('#refresh-scores').addEventListener('click', async () => {
    const button = $('#refresh-scores')
    button.disabled = true
    try {
      await Promise.allSettled([refreshPriorityState(), loadUnifiedUpstreamAssets(true), readUsageCache(scoreRows.map((row) => row.accountId)), loadUnifiedQuotaSummary(), loadPoolQuality(), loadPoolQualityErrors(), loadIdleProbeRollingUsage(), loadPriorityHistory(), loadIdleProbeHistory()])
    }
    catch (error) { $('#score-updated-time').textContent = error instanceof Error ? error.message : String(error) }
    finally { button.disabled = false }
  })
  const [initial] = await Promise.all([
    loadScoreData().then(async (data) => {
      await readUsageCache((data.accounts ?? []).map((row) => row.accountId)).catch((error) => {
        const node = $('#score-updated-time')
        if (node) node.textContent = `余额读取失败：${error instanceof Error ? error.message : String(error)}`
      })
      return data
    }),
    loadUnifiedUpstreamAssets().catch((error) => {
      $('#score-updated-time').textContent = `资产读取失败：${error instanceof Error ? error.message : String(error)}`
    }),
    loadUnifiedQuotaSummary().catch((error) => {
      $('#quota-monitor-state').textContent = `额度读取失败：${error instanceof Error ? error.message : String(error)}`
    }),
    loadPoolQuality().catch((error) => {
      $('#pool-quality-state').textContent = `质量采样读取失败：${error instanceof Error ? error.message : String(error)}`
    }),
    loadPoolQualityErrors().catch((error) => {
      $('#pool-error-state').textContent = `错误记录读取失败：${error instanceof Error ? error.message : String(error)}`
    }),
    loadIdleProbeRollingUsage().catch((error) => {
      $('#idle-probe-rolling').textContent = `探活 24h：读取失败 · ${error instanceof Error ? error.message : String(error)}`
    }),
  ])
  const options = initial.availableCallOptions ?? []
  const preferredLimit = options.includes(1000) ? 1000 : options[0]
  select.innerHTML = options.map((value) => `<option value="${value}"${value === preferredLimit ? ' selected' : ''}>最近 ${number(value)} 次</option>`).join('')
  renderScores(initial)
  setInterval(renderScoreFreshness, 1000)
  await setupPriorityPanel(options)
  scheduleScoreRefresh()
  setInterval(async () => {
    if (!document.hidden) {
      const [scores] = await Promise.allSettled([
        loadScoreData(),
        readUsageCache(scoreRows.map((row) => row.accountId)),
        loadUnifiedQuotaSummary(),
        loadPoolQuality(),
        loadPoolQualityErrors(),
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
    await loadRanking(true, true).catch(() => null)
    scheduleRankingRefresh()
  }, interval * 1000)
}

async function loadRanking(automatic = false, refresh = false) {
  if (rankingLoading) return
  rankingLoading = true
  const button = $('#ranking-refresh')
  button.disabled = true; button.classList.add('is-loading'); button.setAttribute('aria-busy', 'true')
  $('#ranking-state').textContent = automatic ? '自动刷新中，正在排队读取…' : refresh ? '正在刷新用户用量…' : '正在读取用户用量缓存…'
  try { renderRanking(await requestJson('/api/ranking', { refresh }, 60000)) }
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
  $('#ranking-refresh').addEventListener('click', async () => { await loadRanking(false, true); scheduleRankingRefresh() })
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
      state = await requestJson('/api/lottery', { refresh: true })
      renderLottery(state)
    } catch (error) {
      $('#draw-status').textContent = error instanceof Error ? error.message : String(error)
      button.disabled = false
    }
  })
  $('#winner-close').addEventListener('click', () => $('#winner-dialog').close())
}

export function cny(value) {
  return `¥${number(value, 2)}`
}

export function operatingDay() {
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
let procurementPage = 1
let procurementBudget = null

export function renderPager(prefix, pagination) {
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
    await loadOperations({ refresh: true })
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

async function loadOperations({ showCached = false, refresh = false } = {}) {
  if (showCached && cashPage === 1 && auditPage === 1) {
    const cached = readOperationsSnapshot()
    if (cached) renderOperations(cached.ledger, cached.audits)
  }
  const [ledger, audits] = await Promise.all([
    requestJson(`/api/operations/ledger?page=${cashPage}`, { refresh }),
    requestJson(`/api/operations/audits?page=${auditPage}`, { refresh }),
  ])
  renderOperations(ledger, audits)
  writeOperationsSnapshot(ledger, audits)
}


export function usdText(value, digits = 2) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? `$${numeric.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits })}` : '—'
}

async function operationsPage() {
  $('#cash-date').value = operatingDay()
  $('#cash-prev').addEventListener('click', async () => { cashPage -= 1; await loadOperations({ refresh: true }) })
  $('#cash-next').addEventListener('click', async () => { cashPage += 1; await loadOperations({ refresh: true }) })
  $('#audit-prev').addEventListener('click', async () => { auditPage -= 1; await loadOperations({ refresh: true }) })
  $('#audit-next').addEventListener('click', async () => { auditPage += 1; await loadOperations({ refresh: true }) })
  $('#cash-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    await requestJson('/api/operations/cash', { method: 'POST', body: JSON.stringify({
      occurredOn: $('#cash-date').value, direction: $('#cash-direction').value,
      category: $('#cash-category').value, amountCny: Number($('#cash-amount').value),
      description: $('#cash-description').value,
    }) })
    event.currentTarget.reset()
    $('#cash-date').value = operatingDay()
    await loadOperations({ refresh: true })
  })
  $('#procurement-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    procurementBudget = Number($('#procurement-budget').value)
    procurementPage = 1
    await loadProcurement()
    await loadOperations({ refresh: true })
  })
  $('#procurement-prev').addEventListener('click', async () => { procurementPage -= 1; await loadProcurement() })
  $('#procurement-next').addEventListener('click', async () => { procurementPage += 1; await loadProcurement() })
  await Promise.all([loadOperations({ showCached: true }), loadProcurement()])
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


let upstreamValuationPolicy = { defaultCnyPerApiUsd: 1, walletCnyPerApiUsd: {} }

export function applyUpstreamValuationPolicy(value) {
  if (!value) return
  upstreamValuationPolicy = {
    defaultCnyPerApiUsd: Number(value.defaultCnyPerApiUsd) > 0 ? Number(value.defaultCnyPerApiUsd) : 1,
    walletCnyPerApiUsd: value.walletCnyPerApiUsd ?? {},
  }
}

export function normalizedUpstreamWallet(value) {
  return String(value ?? '').trim().split(/\s+/u)[0].replace(/\/v1\/?$/u, '').replace(/\/$/u, '')
}

function upstreamWalletCnyRate(baseUrl) {
  const wallet = normalizedUpstreamWallet(baseUrl)
  const configuredRate = Number(upstreamValuationPolicy.walletCnyPerApiUsd?.[wallet])
  const defaultRate = Number(upstreamValuationPolicy.defaultCnyPerApiUsd)
  return Number.isFinite(configuredRate) && configuredRate > 0 ? configuredRate : defaultRate
}

export function upstreamBalancePresentation(result) {
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

export function upstreamStatus(row) {
  if (row.status === 'active' && row.schedulable) return { label: '可调度', className: 'is-available' }
  if (row.status === 'active') return { label: '已停调度', className: 'is-limited' }
  return { label: row.status || '异常', className: 'is-error' }
}

export function upstreamGroupMarkup(row) {
  const ids = Array.isArray(row.groupIds) ? row.groupIds : []
  const names = Array.isArray(row.groupNames) ? row.groupNames : []
  if (!ids.length && !names.length) return '<span>未分组</span>'
  const compactNames = (names.length ? names : ['分组']).map((name) => {
    const value = String(name)
    return value.length > 3 ? `${value.slice(0, 3)}…` : value
  })
  return `<span title="${escapeHtml(names.join('、') || '分组')} · ${escapeHtml(ids.map((id) => `#${id}`).join('、'))}">${escapeHtml(compactNames.join('、'))} · ${escapeHtml(ids.map((id) => `#${id}`).join('、'))}</span>`
}

export function upstreamOperationId(prefix) {
  return `${prefix}-${typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

export function upstreamUsageMarkup(result, manualRate = null) {
  const quota = result.quota ?? {}
  const usage = result.usage ?? {}
  const balance = upstreamBalancePresentation(result)
  const multiplier = upstreamMultiplierPresentation(result, manualRate)
  const warning = result.warning ? `<p>${escapeHtml(result.warning)}</p>` : ''
  const error = result.error ? `<p>${escapeHtml(result.error)}</p>` : ''
  const displayName = displayAccountName(result.accountName, result.baseUrl) || `账号 #${result.accountId}`
  return `<article class="upstream-usage-result" data-ok="${result.ok === true}">
    <header><div><b>${escapeHtml(displayName)}</b><small>#${escapeHtml(result.accountId)} · ${escapeHtml(result.provider ?? 'unknown')}</small></div><small>${number(result.durationMs)} ms</small></header>
    <dl><dt>账号余额</dt><dd><b>${escapeHtml(balance.primary)}</b><small>${escapeHtml(balance.secondary)}</small></dd><dt>探测成本</dt><dd><b>${escapeHtml(multiplier.primary)}</b><small>${escapeHtml(multiplier.secondary)}</small><small>${escapeHtml(multiplier.comparison)}</small></dd><dt>已用额度</dt><dd>${quota.used == null ? '—' : `${escapeHtml(number(quota.used, 2))} USD`}</dd><dt>Token</dt><dd>${usage.totalTokens == null ? '—' : compact(usage.totalTokens)}</dd><dt>请求</dt><dd>${usage.requestCount == null ? '—' : number(usage.requestCount)}</dd><dt>API 费用</dt><dd>${usage.actualCostUsd == null ? usage.costUsd == null ? '—' : usd(usage.costUsd) : usd(usage.actualCostUsd)}</dd><dt>查询时间</dt><dd>${time(result.queriedAt)}</dd></dl>${warning}${error}
  </article>`
}

export function upstreamMultiplierPresentation(result, manualRate = null) {
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

export async function waitUpstreamJob(workflowId, onStatus = () => {}, timeoutMs = 600000) {
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


async function boot() {
  if (page === 'login') return await loginPage()
  shell()
  if (page === 'scores') return await scoresPage()
  if (page === 'ranking') return await rankingPage()
  if (page === 'lottery') return await lotteryPage()
  if (page === 'operations') return await operationsPage()
  if (page === 'oauth-cost' || page === 'account-import' || page === 'upstreams') {
    const pages = await import('./ledger-pages.js')
    if (page === 'oauth-cost') return await pages.oauthCostPage()
    if (page === 'account-import') return await pages.accountImportPage()
    return await pages.upstreamsPage()
  }
}

boot().catch((error) => {
  const target = $('.workspace') ?? $('main')
  if (target) target.insertAdjacentHTML('afterbegin', `<div class="fatal-state">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`)
})
