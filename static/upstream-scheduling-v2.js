import { renderDonut, poolParticipationColors } from './score-visuals.js'
import { buildSupplierQualityAssets } from './upstream-quality-assets.js'
import { bindHistoryChartTooltip, historyChartMarkup } from './history-chart.js'
import { sampleTimeDisplay } from './sample-time.js'
import { bindTableSortHeaders, sortTableRows, updateTableSortHeaders } from './table-sort.js?v=table-sort-v1'

const $ = (selector) => document.querySelector(selector)
const state = { scopes: [], activeScope: null, snapshot: null, accounts: [], accountPage: 1, errorPage: 1, historyPage: 1, probePage: 1, filter: '', scopeRequestId: 0, accountSort: { key: 'score', direction: 'desc' }, errorSort: { key: 'createdAt', direction: 'desc' }, historySort: { key: 'started_at', direction: 'desc' }, probeSort: { key: 'startedAt', direction: 'desc' } }
const accountPageSize = 10
const errorPageSize = 20
const historyPageSize = 10

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])) }
function number(value, digits = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—' }
function percent(value, digits = 1) { const parsed = Number(value); return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(digits)}%` : '—' }
function money(value) { const parsed = Number(value); return Number.isFinite(parsed) ? `¥${number(parsed, 2)}` : '—' }
function cny(value) { const parsed = Number(value); return Number.isFinite(parsed) ? `¥${number(parsed, 3)}` : '—' }
function time(value) { if (!value) return '—'; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—' }
function scopeLabel(scope) { return scope === 'claude' ? 'Claude' : scope === 'codex' ? 'Codex' : String(scope ?? '') }
function enabledScope(scope) { return state.scopes.find((item) => item.enabled && item.name === scope)?.name ?? null }
function scopeFromLocation(fallback) { return enabledScope(new URLSearchParams(location.search).get('scope')) ?? fallback }
function updateScopeDeepLink(scope, navigation = 'replace') {
  if (!scope || typeof history?.[`${navigation}State`] !== 'function') return
  const url = new URL(location.href)
  url.searchParams.set('scope', scope)
  const next = `${url.pathname}${url.search}${url.hash}`
  const current = `${location.pathname}${location.search}${location.hash}`
  if (next !== current) history[`${navigation}State`]({ scope }, '', next)
}
function resetScopePaging() { state.accountPage = 1; state.errorPage = 1; state.historyPage = 1; state.probePage = 1 }

async function requestJson(path, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(path, { signal: controller.signal, headers: options.refresh ? { 'x-api2business-refresh': '1' } : {}, cache: 'no-store' })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
    return data
  } finally { clearTimeout(timer) }
}

function renderScopeSwitch() {
  const target = $('#v2-scope-switch'); if (!target) return
  target.innerHTML = state.scopes.length ? state.scopes.map((scope) => `<button class="profile-tab${scope.name === state.activeScope ? ' is-active' : ''}" type="button" role="tab" aria-selected="${scope.name === state.activeScope}" data-v2-scope="${escapeHtml(scope.name)}"${scope.enabled ? '' : ' disabled'}>${escapeHtml(scopeLabel(scope.name))}${scope.enabled ? '' : '（待启用）'}</button>`).join('') : '<span class="section-state">没有启用的作用域</span>'
  target.querySelectorAll('[data-v2-scope]').forEach((button) => button.addEventListener('click', () => { if (!button.disabled && button.dataset.v2Scope && button.dataset.v2Scope !== state.activeScope) { state.activeScope = button.dataset.v2Scope; resetScopePaging(); updateScopeDeepLink(state.activeScope, 'push'); renderScopeSwitch(); void loadScope() } }))
}

function renderQuality(quality, scope) {
  const score = Number(quality?.score); const grade = String(quality?.grade ?? 'insufficient'); const label = scopeLabel(scope)
  $('#v2-quality-title').textContent = `${label} 综合质量`; $('#v2-quality-state').textContent = `最近 ${number(quality?.recentCallLimit)} 次被动调用`
  $('#v2-quality-score').textContent = Number.isFinite(score) ? score.toFixed(1) : '—'; $('#v2-quality-grade').textContent = grade === 'insufficient' ? '证据不足' : `${grade} 级`; $('#v2-quality-score').closest('.pool-quality-score').dataset.grade = grade
  $('#v2-quality-outcomes').textContent = `${number(quality?.rawSuccessRequests ?? quality?.successRequests)} / ${number(quality?.rawFailureRequests ?? quality?.failureRequests)}`; $('#v2-quality-failure-rate').textContent = `失败率 ${percent(quality?.failureRate)}`
  $('#v2-quality-failover').textContent = `${number(quality?.rawFailoverRecovered ?? quality?.failoverRecovered)} / ${number(quality?.rawFailoverRequests ?? quality?.failoverRequests)}`; $('#v2-quality-ttft').textContent = quality?.ttftP95Ms == null ? '—' : `${number(Math.round(Number(quality.ttftP95Ms)))} ms`; $('#v2-quality-ttft-samples').textContent = `首 token 样本 ${number(quality?.rawFirstTokenSamples ?? quality?.firstTokenSamples)}`
  const history = Array.isArray(quality?.history) ? quality.history : []
  $('#v2-quality-chart').innerHTML = historyChartMarkup(history, { series: [{ key: 'score', className: 'chart-pool-quality', label: '当前采样' }, { key: 'rollingScore', className: 'chart-pool-quality-rolling', label: '100 点滚动' }], valueFormatter: (value) => number(value, 1), unit: '质量分 / 100', ariaLabel: `${label} 最近一百个采样点综合质量评分`, yMin: 0, yMax: 100 })
  bindHistoryChartTooltip($('#v2-quality-chart'))
  const participation = Array.isArray(quality?.participation) ? quality.participation : []
  renderDonut({ ring: $('#v2-participation-ring'), detail: $('#v2-participation-detail'), items: participation, center: number(quality?.rawCallCount || quality?.participationAttempts || quality?.observedAttempts), centerLabel: '调用', emptyDetail: '暂无参与样本', itemLabel: (item) => item.accountName ?? `账号 #${item.accountId}`, itemDetail: (item) => `${percent(item.ratio)} · ${number(item.rawAttempts ?? item.attempts)} 次` })
  $('#v2-participation-legend').innerHTML = participation.length ? participation.map((item, index) => `<li><i style="--participation-color:${poolParticipationColors[index % poolParticipationColors.length]}"></i><span title="${escapeHtml(item.accountName ?? item.accountId)}"><b>${escapeHtml(item.accountName ?? `账号 #${item.accountId}`)}</b><em>${number(item.rawAttempts ?? item.attempts)} 次</em></span><strong>${percent(item.ratio)}</strong></li>`).join('') : '<li class="empty">暂无参与样本</li>'
}

function availabilityDuration(value) {
  if (value == null || !Number.isFinite(Number(value))) return '暂不可估算'
  const hours = Number(value)
  return hours >= 24 ? `${number(hours / 24, 1)} 天` : `${number(hours, 1)} 小时`
}

function renderQuota(summary = {}, accounts = [], usage = []) {
  const points = Array.isArray(summary.history) ? summary.history : []
  const last = points.at(-1) ?? {}
  const costText = (value) => value == null ? '暂不可计算' : `¥${number(value, 4)}/刀`
  $('#v2-quota-total').textContent = summary.totalRemainingCny == null ? '—' : money(summary.totalRemainingCny)
  $('#v2-quota-schedulable').textContent = summary.schedulableRemainingCny == null ? '—' : money(summary.schedulableRemainingCny)
  $('#v2-quota-consumed').textContent = summary.consumedCny == null ? '暂不可计算' : money(summary.consumedCny)
  $('#v2-quota-output').textContent = summary.apiAmountUsd == null ? '暂不可计算' : cny(summary.apiAmountUsd)
  $('#v2-quota-realtime-cost').textContent = costText(summary.realtimeCostCnyPerApiUsd)
  $('#v2-quota-estimated-hours').textContent = availabilityDuration(summary.estimatedAvailableHours)
  $('#v2-quota-sample-speed').textContent = last.sampleApiAmountUsdPerHour == null ? '暂不可计算' : cny(last.sampleApiAmountUsdPerHour)
  $('#v2-quota-rolling-speed').textContent = last.rollingApiAmountUsdPerHour == null ? '暂不可计算' : cny(last.rollingApiAmountUsdPerHour)
  $('#v2-quota-sample-cost').textContent = costText(summary.sampleRealtimeCostCnyPerApiUsd)
  const wallets = Array.isArray(summary.walletDistribution) ? summary.walletDistribution : []
  renderDonut({ ring: $('#v2-quota-ring'), detail: $('#v2-quota-ring-detail'), items: wallets, center: summary.totalRemainingCny == null ? '—' : money(summary.totalRemainingCny), centerLabel: '总余额', emptyDetail: '暂无可用余额明细', itemLabel: (item) => item.wallet, itemDetail: (item) => `${percent(item.ratio)} · ${money(item.remainingCny)}${item.schedulable ? '' : ' · 不可调度'}` })
  $('#v2-quota-monitor-state').textContent = `${scopeLabel(state.activeScope)} · ${time(summary.sampledAt)} · ${number(summary.knownWallets)} 个钱包${summary.warning ? ` · ${summary.warning}` : ''}`
  const quality = buildSupplierQualityAssets({ walletDistribution: wallets, scoreRows: accounts, upstreamAccounts: usage, consumedCny: summary.consumedCny, burnWindowHours: summary.burnWindowHours })
  renderDonut({ ring: $('#v2-supplier-quality-ring'), detail: $('#v2-supplier-quality-detail'), items: quality.qualityBands, center: money(quality.goodBalanceCny), centerLabel: quality.goodBalanceRatio == null ? '优质余额' : `优质 ${percent(quality.goodBalanceRatio)}`, emptyDetail: '暂无可计算的供应商余额', itemColor: (item) => ({ good: 'var(--signal)', mid: 'var(--warning)', risk: 'var(--line)' })[item.band], itemLabel: (item) => ({ good: '优质', mid: '一般', risk: '不良' })[item.band], itemDetail: (item) => `${money(item.remainingCny)} · ${percent(item.ratio)} · ${number(item.supplierCount)} 个供应商` })
  $('#v2-quota-quality-estimated-hours').textContent = availabilityDuration(quality.estimatedGoodAvailableHours)
  $('#v2-quota-quality-balance').textContent = `评分 >80 · 优质余额 ${money(quality.goodBalanceCny)} · ${number(quality.scoredWallets)} 个已评分`
  $('#v2-quota-balance-chart').innerHTML = historyChartMarkup(points, { series: [{ key: 'sampleApiAmountUsdPerHour', className: 'chart-sample-speed', label: '当前采样' }, { key: 'rollingApiAmountUsdPerHour', className: 'chart-rolling-speed', label: '一小时滚动' }], valueFormatter: (value) => cny(value), unit: '人民币 / 小时', ariaLabel: '作用域上游最近八小时消耗速率', yMin: 0 })
  $('#v2-quota-cost-chart').innerHTML = historyChartMarkup(points, { series: [{ key: 'sampleRealtimeCostCnyPerApiUsd', className: 'chart-cost', label: '当前采样' }, { key: 'realtimeCostCnyPerApiUsd', className: 'chart-rolling-cost', label: '一小时滚动' }], valueFormatter: (value) => `¥${number(value, 4)}`, unit: '人民币 / 刀', ariaLabel: '作用域上游实时成本' })
  bindHistoryChartTooltip($('#v2-quota-balance-chart')); bindHistoryChartTooltip($('#v2-quota-cost-chart'))
}

function filteredAccounts() { const needle = state.filter.trim().toLowerCase(); return state.accounts.filter((row) => !needle || [row.accountName, row.accountId, row.currentStatus, row.status, row.groupName, ...(row.groupNames ?? [])].join(' ').toLowerCase().includes(needle)) }
function accountCost(row) {
  const detected = Number(row.detectedCostRateCnyPerApiUsd)
  if (Number.isFinite(detected) && detected > 0) return detected
  const configured = Number(row.usage?.costRateCnyPerApiUsd)
  return Number.isFinite(configured) && configured > 0 ? configured : null
}
function accountCostSource(row) {
  if (row.costSource === 'detected' || (Number.isFinite(Number(row.detectedCostRateCnyPerApiUsd)) && Number(row.detectedCostRateCnyPerApiUsd) > 0)) return '探测'
  if (row.costSource === 'manual' || (Number.isFinite(Number(row.usage?.costRateCnyPerApiUsd)) && Number(row.usage?.costRateCnyPerApiUsd) > 0)) return '手工'
  return '成本未知'
}
function accountSortValue(row, key) {
  return ({
    accountName: row.accountName ?? row.accountId,
    status: row.currentStatus ?? row.status,
    score: row.score,
    priority: row.priority,
    balance: row.quota?.remaining,
    cost: accountCost(row),
    output: row.usage?.apiAmountUsd,
    sample: row.latestSampleAt,
    failure: row.failureRate,
    ttft: row.ttftP95Ms,
    failover: row.failureRequests,
    groups: (row.groupNames ?? []).join('、'),
  })[key]
}
function renderAccounts() {
  const rows = sortTableRows(filteredAccounts(), state.accountSort, accountSortValue, (a, b) => Number(a.accountId) - Number(b.accountId)); const pages = Math.max(1, Math.ceil(rows.length / accountPageSize)); state.accountPage = Math.min(Math.max(state.accountPage, 1), pages); const visible = rows.slice((state.accountPage - 1) * accountPageSize, state.accountPage * accountPageSize)
  $('#v2-account-body').innerHTML = visible.length ? visible.map((row) => {
    const sample = sampleTimeDisplay(row.latestSampleAt)
    const quotaSample = sampleTimeDisplay(row.quotaCacheAt)
    const attempts = row.attemptCount ?? row.selectedCalls ?? row.observedAttempts ?? 0
    const quotaValue = row.quotaCacheStatus === 'unlimited'
      ? '不限额'
      : row.quotaCacheStatus === 'unavailable'
        ? '缓存不可用'
        : row.quota?.remaining == null ? '—' : cny(row.quota.remaining)
    const quotaLabel = row.quotaCacheStatus === 'cached'
      ? `额度缓存 · ${escapeHtml(quotaSample.label)}`
      : row.quotaCacheStatus === 'unlimited'
        ? `额度缓存 · 不限额 · ${escapeHtml(quotaSample.label)}`
        : row.quotaCacheStatus === 'unavailable' ? '额度缓存不可用' : '额度缓存缺失'
    const cost = accountCost(row)
    const costSource = accountCostSource(row)
    const costTitle = row.costProbe?.source ? `${costSource} · ${row.costProbe.source}` : costSource
    return `<tr><td><strong>${escapeHtml(row.accountName ?? row.accountId)}</strong><small>#${escapeHtml(row.accountId)}</small></td><td>${escapeHtml(row.currentStatus ?? row.status ?? '—')}</td><td><b>${row.score == null ? '—' : Number(row.score).toFixed(1)}</b><small>${escapeHtml(row.grade ?? row.confidence ?? '')}</small></td><td>${number(row.priority)}</td><td>${quotaValue}<small title="${escapeHtml(quotaSample.exact)}">${quotaLabel}</small></td><td title="${escapeHtml(costTitle)}">${cost == null ? '—' : `¥${number(cost, 4)}/刀`}<small>${escapeHtml(costSource)}</small></td><td>${cny(row.usage?.apiAmountUsd)}</td><td class="sample-time sample-time-${sample.freshness}" title="北京时间 ${escapeHtml(sample.exact)}">${escapeHtml(sample.label)}</td><td>${percent(row.failureRate)}<small>${number(attempts)} 次尝试</small></td><td>${row.ttftP95Ms == null ? '—' : `${number(Math.round(Number(row.ttftP95Ms)))} ms`}</td><td>${number(row.failureRequests)} / ${number(row.failoverRequests)} / ${number(row.failoverRecovered)}<small>${number(attempts)} 次采样 · 未触发 ${number(row.failoverNotTriggered)}</small></td><td><div class="group-list">${(row.groupNames ?? []).map((group) => `<span>${escapeHtml(group)}</span>`).join('') || '—'}</div></td><td><span class="section-state">只读</span></td></tr>`
  }).join('') : '<tr><td colspan="13" class="empty">当前作用域没有评分账号</td></tr>'
  updateTableSortHeaders($('#v2-account-table'), state.accountSort)
  $('#v2-account-page').textContent = rows.length ? `${state.accountPage} / ${pages} · 共 ${number(rows.length)} 条` : '0 条'; $('#v2-account-prev').disabled = state.accountPage <= 1; $('#v2-account-next').disabled = state.accountPage >= pages
}

function renderErrors(errors) {
  const rows = Array.isArray(errors?.rows) ? errors.rows : []; const pagination = errors?.pagination ?? { page: 1, totalPages: 1, total: 0 }; state.errorPage = Number(pagination.page ?? 1); $('#v2-error-state').textContent = `最近 ${number(pagination.total)} 条中的 ${number(rows.length)} 条`; $('#v2-error-page').textContent = `${number(pagination.page)} / ${number(pagination.totalPages)} · ${number(pagination.total)} 条`; $('#v2-error-prev').disabled = state.errorPage <= 1; $('#v2-error-next').disabled = state.errorPage >= Number(pagination.totalPages ?? 1); const models = Array.isArray(errors?.modelDistribution) ? errors.modelDistribution : []; $('#v2-error-models').textContent = models.length ? `模型分布：${models.map((item) => `${item.model || 'unknown'} ${number(item.count)}`).join(' · ')}` : '模型分布：当前口径无错误'
  const sorted = sortTableRows(rows, state.errorSort, (row, key) => ({ createdAt: row.createdAt, model: row.model, user: row.userEmail, account: row.accountName, status: row.upstreamStatusCode ?? row.clientStatusCode, endpoint: `${row.inboundEndpoint ?? ''} ${row.upstreamEndpoint ?? ''}`, mode: row.stream ? 1 : 0, message: row.upstreamErrorMessage || row.errorMessage || row.upstreamErrorDetail })[key], (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
  $('#v2-error-body').innerHTML = sorted.length ? sorted.map((row) => { const endpoint = `${row.inboundEndpoint ?? '—'} → ${row.upstreamEndpoint ?? '—'}`; const message = row.upstreamErrorMessage || row.errorMessage || row.upstreamErrorDetail || '无错误正文'; return `<tr><td><time>${escapeHtml(time(row.createdAt))}</time></td><td><b>${escapeHtml(row.model ?? 'unknown')}</b>${row.upstreamModel && row.upstreamModel !== row.model ? `<small>→ ${escapeHtml(row.upstreamModel)}</small>` : ''}</td><td><b>${escapeHtml(row.userEmail ?? '未知用户')}</b><small>#${escapeHtml(row.userId ?? '—')}</small></td><td><b>${escapeHtml(row.accountName ?? '—')}</b><small>#${escapeHtml(row.accountId ?? '—')}</small></td><td><b>${escapeHtml(row.clientStatusCode ?? '—')}</b> / <b>${escapeHtml(row.upstreamStatusCode ?? '—')}</b></td><td>${escapeHtml(endpoint)}</td><td>${row.stream ? '流式' : '同步'}${row.failoverTriggered ? '<small>触发切号</small>' : ''}</td><td title="${escapeHtml(message)}">${escapeHtml(message)}</td></tr>` }).join('') : '<tr><td colspan="8" class="empty">当前作用域没有错误记录</td></tr>'
  updateTableSortHeaders($('#v2-error-table'), state.errorSort)
}

function renderHistory(records) {
  const rows = sortTableRows(Array.isArray(records) ? records : [], state.historySort, (row, key) => ({ pool: state.activeScope, started_at: row.started_at, trigger: row.trigger_type, status: row.status, operator: row.created_by, sample: row.recent_call_limit, changed: (row.profile_changed_counts ?? {})[state.activeScope] ?? row.profile_changed_counts?.codex ?? 0, completed_at: row.completed_at, duration: row.duration_ms })[key], (a, b) => String(a.started_at ?? '').localeCompare(String(b.started_at ?? ''))); const pages = Math.max(1, Math.ceil(rows.length / historyPageSize)); state.historyPage = Math.min(Math.max(state.historyPage, 1), pages); const visible = rows.slice((state.historyPage - 1) * historyPageSize, state.historyPage * historyPageSize); $('#v2-history-body').innerHTML = visible.length ? visible.map((row) => { const counts = row.profile_changed_counts ?? {}; const changed = counts[state.activeScope] ?? counts.codex ?? 0; return `<tr><td><b>${escapeHtml(scopeLabel(state.activeScope))}</b><small>${number(changed)} 项</small></td><td>${escapeHtml(time(row.started_at))}</td><td>${row.trigger_type === 'automatic' ? '自动' : '手动'}</td><td>${escapeHtml(row.status ?? '—')}</td><td>${escapeHtml(row.created_by ?? '—')}</td><td>${number(row.recent_call_limit)}</td><td>${number(changed)}</td><td>${escapeHtml(time(row.completed_at))}</td><td>${row.duration_ms == null ? '—' : `${number(Number(row.duration_ms) / 1000, 1)} 秒`}</td></tr>` }).join('') : '<tr><td colspan="9" class="empty">暂无作用域调整记录</td></tr>'; updateTableSortHeaders($('#v2-history-table'), state.historySort); $('#v2-history-page').textContent = rows.length ? `${state.historyPage} / ${pages} · 共 ${number(rows.length)} 条` : '0 条'; $('#v2-history-prev').disabled = state.historyPage <= 1; $('#v2-history-next').disabled = state.historyPage >= pages
}

function renderScopeFeatures(features = {}, automation) { const write = features.planWrite === true || features.priorityAutomation === true || features.upstreamWrite === true; $('#v2-write-state').textContent = write ? '写入受控' : '写入关闭'; $('#v2-write-state').dataset.state = write ? 'warning' : 'success'; $('#v2-automation-enabled').value = String(features.priorityAutomation === true); $('#v2-automation-plan').value = String(features.planWrite === true); $('#v2-automation-interval').value = automation?.interval_seconds == null ? '' : String(automation.interval_seconds); $('#v2-automation-state').textContent = `自动优先级调度：${features.priorityAutomation === true ? '作用域已开启' : '作用域关闭'} · 探活：${features.idleProbe === true ? '作用域已开启' : '作用域关闭'} · 上游写入：${features.upstreamWrite === true ? '作用域已开启' : '作用域关闭'}` }

function renderProbeHistory(history = {}) {
  const rows = Array.isArray(history.records) ? history.records : []
  const pagination = history.pagination ?? { page: 1, totalPages: 1, total: 0 }
  state.probePage = Number(pagination.page ?? 1)
  const sorted = sortTableRows(rows, state.probeSort, (row, key) => row[key], (a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')))
  $('#v2-probe-body').innerHTML = sorted.length ? sorted.map((row) => `<tr><td>${escapeHtml(time(row.startedAt))}</td><td>${row.triggerType === 'automatic' ? '自动' : '手动'}</td><td>${escapeHtml(row.status)}</td><td>${number(row.planned)}</td><td>${number(row.ready)}</td><td>${number(row.succeeded)}</td><td>${number(row.failed)}</td><td>${number(row.unready)}</td><td>${escapeHtml(time(row.completedAt))}</td><td>${number(Number(row.durationMs) / 1000, 1)} 秒</td></tr>`).join('') : '<tr><td colspan="10" class="empty">当前作用域暂无探活记录</td></tr>'
  updateTableSortHeaders($('#v2-probe-table'), state.probeSort)
  $('#v2-probe-page').textContent = `${state.snapshot?.features?.idleProbe === true ? '自动探活已开启' : '自动探活关闭'} · ${state.probePage} / ${number(pagination.totalPages)} · ${number(pagination.total)} 条`
  $('#v2-probe-prev').disabled = state.probePage <= 1
  $('#v2-probe-next').disabled = state.probePage >= Number(pagination.totalPages ?? 1)
}

async function loadProbeHistory(page) {
  const scope = state.activeScope
  const data = await requestJson(`/api/v2/upstream-scheduling/probe-history?scope=${encodeURIComponent(scope)}&page=${page}`)
  if (scope === state.activeScope) renderProbeHistory(data)
}

function renderSnapshot(data) {
  state.snapshot = data
  state.accounts = data.data?.accounts ?? []
  const quality = data.data?.poolQuality ?? {}
  const quotaCoverage = data.data?.quotaCoverage ?? {}
  const unavailableCount = (quotaCoverage.unavailableAccountIds ?? []).length
  const missingCount = (quotaCoverage.missingAccountIds ?? []).length
  $('#v2-snapshot-time').textContent = time(data.data?.refreshedAt)
  $('#v2-snapshot-detail').textContent = `最近快照：${time(data.data?.refreshedAt)}`
  $('#v2-data-state').textContent = data.data?.status ?? '不可用'
  $('#v2-data-state').dataset.state = data.data?.status === 'ready' ? 'ready' : 'unavailable'
  const cacheState = String(data.cache?.state ?? 'refreshed')
  const cacheLabel = cacheState === 'hit' ? '缓存命中' : cacheState === 'stale' ? '陈旧缓存 · 后台刷新' : '刚完成刷新'
  $('#v2-data-detail').textContent = `${number(state.accounts.length)} 个账号 · ${cacheLabel}`
  $('#v2-account-state-detail').textContent = `${number(state.accounts.length)} 个账号 · 最近样本 ${number(data.data?.recentCallLimit)} · 额度缓存 ${number(quotaCoverage.cachedAccountCount)} / ${number(quotaCoverage.accountCount)} · 数值 ${number(quotaCoverage.numericAccountCount)} · 不限额 ${number(quotaCoverage.unlimitedAccountCount)} · 不可用 ${number(unavailableCount)} · 缺失 ${number(missingCount)}${quotaCoverage.cacheRowsComplete ? ' · 缓存覆盖完整' : ''}`
  renderScopeFeatures(data.features, data.data?.automation)
  renderQuality(quality, data.scope)
  renderQuota(data.data?.quota, state.accounts, data.data?.usage ?? [])
  renderAccounts()
  renderErrors(data.data?.errors ?? {})
  renderHistory(data.data?.priorityHistory ?? [])
  renderProbeHistory(data.data?.probeHistory ?? {})
  performance.mark(`upstream-scheduling-v2:${data.scope}:rendered`)
}

async function loadScope(forceRefresh = false) { if (!state.activeScope) return; const scope = state.activeScope; const requestId = ++state.scopeRequestId; $('#v2-data-state').textContent = forceRefresh ? '刷新中' : '读取中'; try { const data = await requestJson(`/api/v2/upstream-scheduling/snapshot?scope=${encodeURIComponent(scope)}`, { refresh: forceRefresh }); if (requestId !== state.scopeRequestId || state.activeScope !== scope) return; renderSnapshot(data) } catch (error) { if (requestId !== state.scopeRequestId || state.activeScope !== scope) return; $('#v2-data-state').textContent = '读取失败'; $('#v2-data-state').dataset.state = 'unavailable'; $('#v2-data-detail').textContent = error instanceof Error ? error.message : String(error) } }
function bindControls() {
  $('#v2-refresh').addEventListener('click', () => void loadScope(true))
  $('#v2-filter-apply').addEventListener('click', () => { state.filter = $('#v2-account-filter').value; state.accountPage = 1; renderAccounts() })
  $('#v2-account-filter').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#v2-filter-apply').click() })
  $('#v2-account-prev').addEventListener('click', () => { state.accountPage -= 1; renderAccounts() })
  $('#v2-account-next').addEventListener('click', () => { state.accountPage += 1; renderAccounts() })
  $('#v2-history-prev').addEventListener('click', () => { state.historyPage -= 1; renderHistory(state.snapshot?.data?.priorityHistory ?? []) })
  $('#v2-history-next').addEventListener('click', () => { state.historyPage += 1; renderHistory(state.snapshot?.data?.priorityHistory ?? []) })
  bindTableSortHeaders($('#v2-account-table'), () => state.accountSort, (next) => { state.accountSort = next; state.accountPage = 1; renderAccounts() })
  bindTableSortHeaders($('#v2-error-table'), () => state.errorSort, (next) => { state.errorSort = next; renderErrors(state.snapshot?.data?.errors ?? {}) })
  bindTableSortHeaders($('#v2-history-table'), () => state.historySort, (next) => { state.historySort = next; state.historyPage = 1; renderHistory(state.snapshot?.data?.priorityHistory ?? []) })
  bindTableSortHeaders($('#v2-probe-table'), () => state.probeSort, (next) => { state.probeSort = next; renderProbeHistory(state.snapshot?.data?.probeHistory ?? {}) })
}

export async function upstreamSchedulingV2Page() { bindControls(); $('#v2-probe-prev').addEventListener('click', () => void loadProbeHistory(state.probePage - 1)); $('#v2-probe-next').addEventListener('click', () => void loadProbeHistory(state.probePage + 1)); window.addEventListener('popstate', () => { const fallback = state.scopes.find((scope) => scope.enabled)?.name ?? null; const next = scopeFromLocation(fallback); if (!next || next === state.activeScope) return; state.activeScope = next; resetScopePaging(); renderScopeSwitch(); void loadScope() }); try { const data = await requestJson('/api/v2/upstream-scheduling/scopes'); state.scopes = Array.isArray(data.scopes) ? data.scopes : []; const fallback = typeof data.defaultScope === 'string' ? data.defaultScope : state.scopes.find((scope) => scope.enabled)?.name ?? null; state.activeScope = scopeFromLocation(fallback); updateScopeDeepLink(state.activeScope); renderScopeSwitch(); await loadScope() } catch (error) { $('#v2-data-state').textContent = '读取失败'; $('#v2-data-state').dataset.state = 'unavailable'; $('#v2-data-detail').textContent = error instanceof Error ? error.message : String(error) } }
