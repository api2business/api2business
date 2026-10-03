import { quotaAccountAvailable, quotaAvailabilityTotals } from './quota-availability.js'
import { bindHistoryChartTooltip, finiteChartValue, historyChartMarkup } from './history-chart.js?v=quota-monitor-v18'
import { quotaGroup, quotaMemberships } from './quota-grouping.js'

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
  const redirectOnUnauthorized = options.redirectOnUnauthorized !== false
  const { refresh: _refresh, redirectOnUnauthorized: _redirectOnUnauthorized, ...fetchOptions } = options
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
    if (response.status === 401 && page !== 'login' && redirectOnUnauthorized) {
      location.assign('/login')
      throw new Error('登录状态已失效')
    }
    if (!response.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
    return data
  } finally {
    clearTimeout(timer)
  }
}

async function shell() {
  const mount = $('[data-shell]')
  if (!mount) return
  const links = [
    ['upstream-scheduling-v2', '/upstream-scheduling-v2', '上游调度 V2'],
    ['quota-monitor', '/quota-monitor', '额度监控'],
    ['ranking', '/ranking', '用户用量'],
    ['lottery', '/lottery', '额度抽奖'],
    ['operations', '/operations', '经营管理'],
    ['oauth-cost', '/oauth-cost', 'OAuth 实时成本'],
    ['bugteam-cost', '/bugteam-cost', 'BugTeam 实时成本'],
    ['account-import', '/account-import', '账号导入'],
  ]
  mount.innerHTML = `<header class="topbar">
    <a class="brand" href="/"><span class="brand-mark">AS</span><span><b>Api2Business</b><small>Sub2API Operations</small></span></a>
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
      location.assign('/')
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause)
    } finally {
      button.disabled = false
    }
  })
}

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

let quotaMonitorRows = []
let quotaMonitorTotalRemaining = null
let quotaMonitorFilter = 'all'
const quotaRangeQuery = new URLSearchParams(location.search).get('range')
let quotaMonitorRange = quotaRangeQuery === 'today' || quotaRangeQuery === '1h' ? quotaRangeQuery : '24h'
let quotaMonitorPageNumber = 1
let quotaMonitorSort = { key: 'remaining', direction: 'desc' }
const quotaMonitorPageSize = 12

function quotaGroupNames(row) {
  const names = Array.isArray(row.groupNames) ? row.groupNames : Array.isArray(row.groups) ? row.groups : [row.groupName]
  return names.filter(Boolean).map((value) => String(value))
}

function quotaWallet(value) {
  const normalized = String(value ?? '').replace(/\/v1\/?$/u, '').replace(/\/$/u, '')
  return normalized === 'https://direct.rapidapi.cc' ? 'https://rapidapi.cc' : normalized
}

function quotaUsageAmount(result) {
  const usage = result?.usage ?? {}
  for (const key of ['actualCostUsd', 'apiAmountUsd', 'totalCostUsd', 'costUsd']) {
    const value = Number(usage[key] ?? result?.[key])
    if (Number.isFinite(value)) return value
  }
  return 0
}

function quotaRemaining(result) {
  const quota = result?.quota ?? {}
  const value = Number(quota.remaining ?? result?.remaining)
  return Number.isFinite(value) ? value : null
}

function quotaDisplay(value) { return value === null ? '—' : `¥${number(value, 2)}` }

function quotaRangeCutoff(range, now = Date.now()) {
  if (range === '1h') return now - 3_600_000
  if (range === 'today') {
    const beijing = new Date(now + 8 * 3_600_000)
    return Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate()) - 8 * 3_600_000
  }
  return now - 24 * 3_600_000
}

function quotaRangeLabel(range) {
  return range === '1h' ? '最近 1 小时' : range === 'today' ? '今天（北京时间）' : '最近 24 小时'
}

function refreshQuotaConsumption() {
  const cutoff = quotaRangeCutoff(quotaMonitorRange)
  const now = Date.now()
  for (const row of quotaMonitorRows) {
    row.consumed24h = 0
    row.consumption = { 'codex-mix': 0, 'no-degrade': 0, claude: 0, grok: 0 }
    for (const point of row.usagePoints ?? []) {
      const sampledAt = Date.parse(point.sampledAt)
      if (!Number.isFinite(sampledAt) || sampledAt < cutoff || sampledAt > now) continue
      const amountCny = Number(point.apiAmountUsd) * (row.walletRate ?? 1)
      if (!Number.isFinite(amountCny)) continue
      row.consumed24h += amountCny
      const group = point.groupName ? quotaGroup({ groupName: point.groupName }) : row.group
      row.consumption[group] += amountCny
    }
  }
}

function quotaPieMarkup(group, rows) {
  const { total, available, unavailable, ratio } = quotaAvailabilityTotals(rows, group)
  const labels = { 'codex-mix': 'Codex 混池', 'no-degrade': '不降智分组', claude: 'Claude', grok: 'Grok' }
  return `<article class="quota-group-card"><div class="quota-group-card-head"><div><p class="eyebrow">${labels[group]}</p><h3>${quotaDisplay(total)}</h3></div><span>${number(rows.length)} 个上游钱包</span></div><div class="quota-pie" style="--quota-pie:${ratio * 360}deg"><strong>${number(ratio * 100, 0)}%</strong><small>可用额度占比</small></div><dl><div><dt>可用额度</dt><dd>${quotaDisplay(available)}</dd></div><div><dt>不可用额度</dt><dd>${quotaDisplay(unavailable)}</dd></div></dl></article>`
}

function renderQuotaMonitor() {
  refreshQuotaConsumption()
  const groups = ['codex-mix', 'no-degrade', 'claude', 'grok']
  const grouped = Object.fromEntries(groups.map((group) => [group, quotaMonitorRows.filter((row) => quotaMemberships(row).has(group))]))
  const cards = $('#quota-group-cards'); if (cards) cards.innerHTML = groups.map((group) => quotaPieMarkup(group, grouped[group])).join('')
  const filteredRows = quotaMonitorFilter === 'all' ? quotaMonitorRows : quotaMonitorRows.filter((row) => quotaMemberships(row).has(quotaMonitorFilter))
  const sorted = filteredRows.slice().sort((a, b) => {
    const read = (row) => quotaMonitorSort.key.startsWith('consumption.') ? row.consumption[quotaMonitorSort.key.slice('consumption.'.length)] : row[quotaMonitorSort.key]
    const av = read(a); const bv = read(b)
    const result = typeof av === 'string' ? String(av).localeCompare(String(bv)) : (Number(av ?? -Infinity) - Number(bv ?? -Infinity))
    return (quotaMonitorSort.direction === 'asc' ? result : -result) || Number(a.accountId) - Number(b.accountId)
  })
  const totalPages = Math.max(1, Math.ceil(sorted.length / quotaMonitorPageSize)); quotaMonitorPageNumber = Math.min(quotaMonitorPageNumber, totalPages)
  const pageRows = sorted.slice((quotaMonitorPageNumber - 1) * quotaMonitorPageSize, quotaMonitorPageNumber * quotaMonitorPageSize)
  const body = $('#quota-monitor-body'); if (body) body.innerHTML = pageRows.length ? pageRows.map((row) => `<tr><td><strong>${escapeHtml(row.name)}</strong><small>${number(row.accountCount)} 个账号 · ${escapeHtml(row.wallet)}</small></td><td>${quotaDisplay(row.remaining)}</td><td>${quotaDisplay(row.consumed24h)}</td><td>${quotaDisplay(row.consumption['codex-mix'])}</td><td>${quotaDisplay(row.consumption['no-degrade'])}</td><td>${quotaDisplay(row.consumption.claude)}</td><td>${quotaDisplay(row.consumption.grok)}</td><td>${escapeHtml(row.groups.join('、') || '—')}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">暂无额度缓存数据</td></tr>'
  const state = $('#quota-monitor-state'); if (state) state.textContent = `上游总资产 ${quotaDisplay(quotaMonitorTotalRemaining)} · ${quotaRangeLabel(quotaMonitorRange)} · 读取 ${number(quotaMonitorRows.length)} 个上游钱包 · 共 ${totalPages} 页 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
  const consumptionLabel = $('#quota-monitor-consumption-label'); if (consumptionLabel) consumptionLabel.textContent = `${quotaRangeLabel(quotaMonitorRange)}消耗`
  const pageLabel = $('#quota-monitor-page'); if (pageLabel) pageLabel.textContent = `${quotaMonitorPageNumber} / ${totalPages} · ${number(sorted.length)} 条`
  $('#quota-monitor-prev')?.toggleAttribute('disabled', quotaMonitorPageNumber <= 1); $('#quota-monitor-next')?.toggleAttribute('disabled', quotaMonitorPageNumber >= totalPages)
  document.querySelectorAll('[data-quota-sort]').forEach((header) => { header.setAttribute('aria-sort', header.dataset.quotaSort === quotaMonitorSort.key ? (quotaMonitorSort.direction === 'asc' ? 'ascending' : 'descending') : 'none') })
  document.querySelectorAll('[data-quota-filter]').forEach((button) => button.classList.toggle('is-active', button.dataset.quotaFilter === quotaMonitorFilter))
}

async function quotaMonitorAccountRead(path, accountIds) {
  const chunks = []
  for (let index = 0; index < accountIds.length; index += 100) chunks.push(accountIds.slice(index, index + 100))
  const results = await Promise.all(chunks.map((chunk) => requestJson(`${path}?accountIds=${chunk.join(',')}`, { redirectOnUnauthorized: false })))
  if (path.endsWith('/usage-cache')) return { results: results.flatMap((item) => item.results ?? []) }
  return { ...results[0], rows: results.flatMap((item) => item.rows ?? []) }
}

let quotaGroupHistoryPoints = []
let quotaHistoryResizeObserver = null

function renderQuotaGroupHistory(points) {
  const chart = $('#quota-group-history-chart')
  if (!chart) return
  quotaGroupHistoryPoints = Array.isArray(points) ? points : []
  const chartHost = chart.parentElement
  const measuredHeight = chartHost?.getBoundingClientRect().height ?? 0
  const responsiveHeight = Math.round(window.innerHeight * 0.36)
  const frameHeight = measuredHeight > 220 ? measuredHeight : responsiveHeight
  if (chartHost) chartHost.style.height = `${Math.max(260, Math.min(440, frameHeight))}px`
  const chartWidth = Math.max(280, chartHost?.clientWidth ?? chart.clientWidth)
  const chartHeight = Math.max(260, Math.min(440, frameHeight))
  chart.setAttribute('viewBox', `0 0 ${chartWidth} ${chartHeight}`)
  chart.setAttribute('preserveAspectRatio', 'none')
  chart.style.setProperty('--quota-chart-height', `${chartHeight}px`)
  chart.style.height = `${chartHeight}px`
  if (!quotaHistoryResizeObserver) {
    quotaHistoryResizeObserver = new ResizeObserver(() => renderQuotaGroupHistory(quotaGroupHistoryPoints))
    quotaHistoryResizeObserver.observe(chartHost ?? chart)
  }
  chart.innerHTML = historyChartMarkup(quotaGroupHistoryPoints, {
    series: [
      { key: 'codexMix', className: 'chart-quota-codex', label: 'Codex 混池' },
      { key: 'noDegrade', className: 'chart-quota-no-degrade', label: '不降智' },
      { key: 'claude', className: 'chart-quota-claude', label: 'Claude' },
      { key: 'grok', className: 'chart-quota-grok', label: 'Grok' },
    ],
    valueFormatter: (value) => `¥${number(value, 2)}`,
    unit: '人民币余额',
    ariaLabel: '四个额度分组人民币余额趋势',
    chartWidth,
    chartHeight,
    plotRight: chartWidth - 12,
    yMin: 0,
    plotLeft: 0,
  })
  bindHistoryChartTooltip(chart)
}

let quotaMonitorLoading = false
let quotaMonitorAutoTimer = null

async function quotaMonitorPage() {
  const filterBar = $('#quota-monitor-filters')
  if (filterBar && filterBar.dataset.bound !== '1') {
    filterBar.dataset.bound = '1'
    filterBar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-quota-filter]')
      if (!button) return
      quotaMonitorFilter = button.dataset.quotaFilter ?? 'all'
      quotaMonitorPageNumber = 1
      renderQuotaMonitor()
    })
  }
  const rangeSelect = $('#quota-monitor-range')
  if (rangeSelect && rangeSelect.dataset.bound !== '1') {
    rangeSelect.dataset.bound = '1'
    rangeSelect.value = quotaMonitorRange
    rangeSelect.addEventListener('change', (event) => {
      quotaMonitorRange = event.target.value === 'today' || event.target.value === '1h' ? event.target.value : '24h'
      const url = new URL(location.href)
      if (quotaMonitorRange === '24h') url.searchParams.delete('range')
      else url.searchParams.set('range', quotaMonitorRange)
      history.replaceState({}, '', url)
      quotaMonitorPageNumber = 1
      renderQuotaMonitor()
    })
  }
  if (!$('#quota-monitor-refresh')?.dataset.bound) {
    $('#quota-monitor-refresh').dataset.bound = '1'
    document.querySelectorAll('[data-quota-sort]').forEach((header) => header.addEventListener('click', () => { const key = header.dataset.quotaSort; if (quotaMonitorSort.key === key) quotaMonitorSort.direction = quotaMonitorSort.direction === 'asc' ? 'desc' : 'asc'; else { quotaMonitorSort = { key, direction: 'desc' } }; renderQuotaMonitor() }))
    $('#quota-monitor-prev')?.addEventListener('click', () => { quotaMonitorPageNumber = Math.max(1, quotaMonitorPageNumber - 1); renderQuotaMonitor() })
    $('#quota-monitor-next')?.addEventListener('click', () => { quotaMonitorPageNumber += 1; renderQuotaMonitor() })
    const setQuotaBusy = (busy, mode = '') => {
      quotaMonitorLoading = busy
      const refreshButton = $('#quota-monitor-refresh'); const sampleButton = $('#quota-monitor-sample')
      if (refreshButton) { refreshButton.disabled = busy; refreshButton.classList.toggle('is-loading', busy && mode === 'refresh'); refreshButton.setAttribute('aria-busy', busy && mode === 'refresh' ? 'true' : 'false') }
      if (sampleButton) { sampleButton.disabled = busy; sampleButton.classList.toggle('is-loading', busy && mode === 'sample'); sampleButton.setAttribute('aria-busy', busy && mode === 'sample' ? 'true' : 'false') }
    }
    const runQuotaRefresh = async () => {
      if (quotaMonitorLoading) return
      setQuotaBusy(true, 'refresh')
      try { if ($('#quota-monitor-state')) $('#quota-monitor-state').textContent = '正在读取最新额度缓存，旧数据保持可见…'; await quotaMonitorPage() }
      catch (error) { if ($('#quota-monitor-state')) $('#quota-monitor-state').textContent = `刷新失败：${error instanceof Error ? error.message : String(error)}` }
      finally { setQuotaBusy(false) }
    }
    const runQuotaSample = async () => {
      if (quotaMonitorLoading) return
      setQuotaBusy(true, 'sample')
      try {
        if ($('#quota-monitor-state')) $('#quota-monitor-state').textContent = '正在手动采样，完成后写入曲线并读取最新缓存…'
        const submitted = await requestJson('/api/upstreams/quota-monitor/sample', { method: 'POST', redirectOnUnauthorized: false }, 30000)
        if (submitted.workflowId) await waitUpstreamJob(submitted.workflowId, () => {}, 300000)
        await quotaMonitorPage()
      } catch (error) { if ($('#quota-monitor-state')) $('#quota-monitor-state').textContent = `采样失败：${error instanceof Error ? error.message : String(error)}` }
      finally { setQuotaBusy(false) }
    }
    $('#quota-monitor-refresh')?.addEventListener('click', runQuotaRefresh)
    $('#quota-monitor-sample')?.addEventListener('click', runQuotaSample)
    const interval = $('#quota-monitor-refresh-interval')
    const scheduleAutoRefresh = () => { if (quotaMonitorAutoTimer) clearTimeout(quotaMonitorAutoTimer); const seconds = Math.max(10, Number(interval?.value ?? 30)); quotaMonitorAutoTimer = setTimeout(async () => { await runQuotaRefresh(); scheduleAutoRefresh() }, seconds * 1000) }
    interval?.addEventListener('change', scheduleAutoRefresh); scheduleAutoRefresh()
  }
  const state = $('#quota-monitor-state'); if (state && !quotaMonitorLoading) state.textContent = '正在读取已有额度缓存…'
  const firstPage = await requestJson('/api/upstreams?page=1')
  const accounts = [...(firstPage.accounts ?? [])]
  const totalPages = Number(firstPage.totalPages ?? 1)
  if (totalPages > 1) {
    const pages = await Promise.all(Array.from({ length: Math.min(totalPages, 20) - 1 }, (_, index) => requestJson(`/api/upstreams?page=${index + 2}`)))
    for (const data of pages) accounts.push(...(data.accounts ?? []))
  }
  const ids = accounts.map((row) => Number(row.id)).filter(Number.isSafeInteger)
  const [cached, usage24h, summary] = await Promise.all([
    ids.length ? quotaMonitorAccountRead('/api/upstreams/usage-cache', ids) : Promise.resolve({ results: [] }),
    ids.length ? quotaMonitorAccountRead('/api/upstreams/quota-monitor-usage', ids) : Promise.resolve({ rows: [] }),
    requestJson('/api/upstreams/quota-summary', { redirectOnUnauthorized: false }),
  ])
  const sourceTotal = Number(summary.totalRemainingCny)
  quotaMonitorTotalRemaining = Number.isFinite(sourceTotal) ? sourceTotal : null
  const remainingByWallet = new Map((summary.walletDistribution ?? []).map((row) => [String(row.wallet), Number(row.remainingCny)]))
  const walletRateByWallet = new Map((summary.walletDistribution ?? []).map((row) => {
    const usd = Number(row.remainingUsd), cny = Number(row.remainingCny)
    return [String(row.wallet), Number.isFinite(usd) && usd > 0 && Number.isFinite(cny) && cny > 0 ? cny / usd : 1]
  }))
  const usageById = new Map()
  renderQuotaGroupHistory(summary.groupHistory)
  for (const item of usage24h.rows ?? []) {
    const id = Number(item.accountId); const current = usageById.get(id) ?? []
    current.push(item); usageById.set(id, current)
  }
  const stateById = new Map((usage24h.rows ?? []).map((row) => [Number(row.accountId), row]))
  const wallets = new Map()
  for (const account of accounts) {
    const wallet = quotaWallet(account.baseUrl)
    if (!wallet) continue
    const current = wallets.get(wallet) ?? { wallet, accounts: [], groupRows: [], usagePoints: [], consumed24h: 0, consumption: { 'codex-mix': 0, 'no-degrade': 0, claude: 0, grok: 0 } }
    current.accounts.push(account)
    current.groupRows.push(account)
    // 按请求实际所属组统计，账号挂多个组不会重复记账；每个账号先换算人民币再合并钱包。
    for (const usage of usageById.get(Number(account.id)) ?? []) {
      for (const point of usage.usageBuckets ?? []) current.usagePoints.push(point)
      const amountUsd = Number(usage.apiAmountUsd)
      if (!Number.isFinite(amountUsd)) continue
      const amountCny = amountUsd * (walletRateByWallet.get(wallet) ?? 1)
      current.consumed24h += amountCny
      current.consumption[usage.groupName ? quotaGroup(usage) : quotaGroup(account)] += amountCny
    }
    wallets.set(wallet, current)
  }
  quotaMonitorRows = [...wallets.values()].map((walletRow, index) => {
    const representative = walletRow.accounts[0] ?? {}
    const group = quotaGroup({ ...representative, groupNames: walletRow.accounts.flatMap((account) => quotaGroupNames(account)) })
    const availableGroups = [...new Set(walletRow.accounts.filter((account) => quotaAccountAvailable(stateById.get(Number(account.id))))
      .flatMap((account) => [...quotaMemberships(account)]))]
    const remaining = remainingByWallet.get(walletRow.wallet) ?? null
    const availableRemainingByGroup = Object.fromEntries(['codex-mix', 'no-degrade', 'claude', 'grok'].map((key) => {
      const scoped = walletRow.accounts.filter((account) => quotaMemberships(account).has(key))
      const availableCount = scoped.filter((account) => quotaAccountAvailable(stateById.get(Number(account.id)))).length
      return [key, remaining === null || scoped.length === 0 ? 0 : remaining * availableCount / scoped.length]
    }))
    return { accountId: Number(representative.id) || index + 1, name: walletRow.wallet, wallet: walletRow.wallet, walletRate: walletRateByWallet.get(walletRow.wallet) ?? 1, usagePoints: walletRow.usagePoints, accountCount: walletRow.accounts.length, platform: representative.platform ?? '—', groups: [...new Set(walletRow.accounts.flatMap((account) => quotaGroupNames(account)))], group, availableGroups, availableRemainingByGroup, remaining, consumed24h: 0, consumption: { 'codex-mix': 0, 'no-degrade': 0, claude: 0, grok: 0 } }
  })
  renderQuotaMonitor()
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
    const status = await requestJson(`/api/upstreams/jobs/${encodeURIComponent(workflowId)}`, { redirectOnUnauthorized: false }, 20000)
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

async function waitWorkflow(workflowId, timeoutMs = 600000, redirectOnUnauthorized = true) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await requestJson(`/api/admin/workflows/${encodeURIComponent(workflowId)}`, { redirectOnUnauthorized }, 20000)
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
  await shell()
  if (page === 'upstream-scheduling-v2') {
    const v2 = await import('./upstream-scheduling-v2.js?v=v2-read-model-cache-1')
    return await v2.upstreamSchedulingV2Page()
  }
  if (page === 'quota-monitor') return await quotaMonitorPage()
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
