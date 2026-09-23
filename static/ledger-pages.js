import { bindHistoryChartTooltip, finiteChartValue, historyChartMarkup } from './history-chart.js'
import {
  $,
  applyUpstreamValuationPolicy,
  cny,
  compact,
  displayAccountName,
  duration,
  escapeHtml,
  loadExternalCutoffHistory,
  number,
  percent,
  renderDonut,
  renderExternalCutoffLogs,
  renderPager,
  requestJson,
  time,
  upstreamBalancePresentation,
  upstreamGroupMarkup,
  upstreamMultiplierPresentation,
  upstreamOperationId,
  upstreamStatus,
  upstreamUsageMarkup,
  usd,
  usdText,
  waitUpstreamJob,
} from './app.js'

let oauthPage = 1
let oauthArchivedPage = 1
let oauthProfile = 'codex'
let oauthRuntimeSnapshot = null
let oauthCurrentRemainingExpected = null
let oauthRefreshTimer = null
let oauthRefreshCountdownTimer = null
let oauthRefreshDueAt = null
let oauthCutoffCountdownTimer = null
let oauthCutoffDueAt = null
let oauthCutoffRunning = false
let oauthCostLoading = false

const oauthRefreshIntervalStorageKey = 'api2business.operations.oauth-refresh-interval.v2'
const oauthRefreshIntervals = new Set([0, 30, 60, 120, 300])

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
  const apiKeyCount = $('#oauth-api-key-schedulable')
  if (apiKeyCount) { apiKeyCount.textContent = number(summary.apiKeySchedulableCount); apiKeyCount.dataset.value = String(summary.apiKeySchedulableCount ?? 0) }
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
    await loadOauthCost({ automatic: true, refresh: true }).catch(() => null)
    scheduleOauthCostRefresh()
  }, interval * 1000)
}

async function loadOauthCost({ automatic = false, refresh = false } = {}) {
  if (oauthCostLoading) return
  oauthCostLoading = true
  const button = $('#oauth-cost-refresh')
  button.disabled = true
  button.classList.add('is-loading')
  button.setAttribute('aria-busy', 'true')
  $('#oauth-cost-state').textContent = automatic ? '自动刷新中，正在通过单连接队列核算…' : '正在通过单连接队列核算…'
  try {
    const cutoffHistoryRequest = loadOauthCutoffHistory().catch(() => null)
    const runtimeRequest = requestJson(`/api/oauth/runtime-summary?profile=${oauthProfile}`)
      .then(renderOauthRuntimeSummary)
      .catch((error) => {
        $('#oauth-runtime-state').textContent = `采样读取失败：${error instanceof Error ? error.message : String(error)}`
      })
    const data = await requestJson(`/api/operations/oauth-cost?profile=${oauthProfile}&page=${oauthPage}&archivedPage=${oauthArchivedPage}`, { refresh }, 60000)
    renderOauthCost(data)
    await Promise.all([runtimeRequest, cutoffHistoryRequest])
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

function renderOauthApiKeyCutoffCountdown() {
  const state = $('#oauth-api-key-cutoff-state')
  if (!state) return
  if (oauthCutoffDueAt === null) {
    state.textContent = '默认 2 分钟，完成后自动恢复'
    return
  }
  const seconds = Math.max(0, Math.ceil((oauthCutoffDueAt - Date.now()) / 1000))
  if (seconds === 0) {
    state.textContent = '正在恢复 API Key 调度…'
    return
  }
  const minutes = Math.floor(seconds / 60)
  state.textContent = `API Key 已切断，${minutes}分${String(seconds % 60).padStart(2, '0')}秒后自动恢复`
}

let oauthCutoffLogs = []
let oauthCutoffHistoryLoading = false
let oauthCutoffHistoryTimer = null
function readOauthCutoffLogs() { return oauthCutoffLogs }
function saveOauthCutoffLogs(rows) { oauthCutoffLogs = rows.slice(-100) }
function cutoffTriggerLabel(row) {
  const source = row.trigger === 'bugteam-import' ? 'BugTeam 导入' : row.trigger === 'account-import' ? '账号导入' : row.trigger === 'external-error' ? '外部断流' : '手动'
  if (row.action === 'restore') return `${source} · ${row.restoreReason ?? '自动恢复'}`
  return `${source} · 计划 ${number(row.durationSeconds)} 秒`
}
async function loadOauthCutoffHistory() {
  if (oauthCutoffHistoryLoading) return
  oauthCutoffHistoryLoading = true
  try {
    const data = await requestJson('/api/oauth/api-key-cutoff/history')
    oauthCutoffLogs = (data.events ?? []).filter((row) => row.trigger !== 'external-error').map((row) => ({
      ...row,
      trigger: cutoffTriggerLabel(row),
      resultLabel: row.action === 'restore' ? `成功 · 恢复 ${number(row.afterCount)} 个` : '成功',
    }))
    renderOauthCutoffLogs()
  } finally {
    oauthCutoffHistoryLoading = false
  }
}

async function runExternalCutoff() {
  const accountId = Number($('#external-cutoff-account')?.value)
  const state = $('#external-cutoff-state')
  const button = $('#external-cutoff-run')
  if (!Number.isSafeInteger(accountId) || accountId < 1) { if (state) state.textContent = '请输入有效账号 ID'; return }
  const mode = $('#external-cutoff-live')?.checked ? 'live' : 'dryrun'
  button.disabled = true; button.classList.add('is-loading')
  try {
    const result = await requestJson('/api/admin/external-cutoff', { method: 'POST', body: JSON.stringify({ accountId, mode, statusCode: 502, phase: 'upstream', text: 'stream_read_error upstream stream disconnected' }) })
    if (state) state.textContent = result.matched ? `${mode} 已提交，等待 1 分钟恢复` : '未命中外部断流规则'
    await loadOauthCutoffHistory()
  } catch (error) { if (state) state.textContent = error instanceof Error ? error.message : String(error) }
  finally { button.disabled = false; button.classList.remove('is-loading') }
}
function startOauthCutoffHistoryRefresh() {
  if (oauthCutoffHistoryTimer !== null) clearInterval(oauthCutoffHistoryTimer)
  oauthCutoffHistoryTimer = setInterval(() => {
    void loadOauthCutoffHistory().catch(() => null)
  }, 5000)
}
function renderOauthCutoffLogs() {
  const body = $('#oauth-cutoff-log-body'); if (!body) return
  const rows = readOauthCutoffLogs().slice().reverse()
  body.innerHTML = rows.length ? rows.map((row) => `<tr data-result="${escapeHtml(row.result ?? 'pending')}"><td>${escapeHtml(time(row.occurredAt))}</td><td>${row.action === 'restore' ? '恢复' : '切断'}</td><td>${number(row.beforeCount)}</td><td>${number(row.afterCount)}</td><td>${escapeHtml(row.trigger ?? '—')}</td><td>${escapeHtml(row.resultLabel ?? '进行中')}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">暂无 API Key 调度记录</td></tr>'
  body.dataset.loaded = 'true'
}

async function cutoffOauthApiKeys() {
  if (oauthCutoffRunning) return
  const button = $('#oauth-api-key-cutoff')
  const buttonLabel = button.querySelector('span:last-child')
  const durationSeconds = Number($('#oauth-api-key-cutoff-duration').value)
  if (!Number.isInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > 3600) {
    $('#oauth-api-key-cutoff-state').textContent = '时长必须为 30–3600 秒'
    return
  }
  oauthCutoffRunning = true
  button.disabled = true
  button.classList.add('is-loading')
  try {
    const submitted = await requestJson('/api/oauth/api-key-cutoff', { method: 'POST', body: JSON.stringify({ durationSeconds }) })
    const cutoffLog = {
      id: `${submitted.workflowId}:cutoff`, workflowId: submitted.workflowId,
      occurredAt: submitted.startedAt, action: 'cutoff',
      beforeCount: Number($('#oauth-api-key-schedulable')?.dataset.value ?? 0), afterCount: 0,
      trigger: `手动 · 计划 ${number(durationSeconds)} 秒`, result: 'pending', resultLabel: '切断已提交',
    }
    const logs = readOauthCutoffLogs(); logs.push(cutoffLog); saveOauthCutoffLogs(logs); renderOauthCutoffLogs()
    const apiKeyCount = $('#oauth-api-key-schedulable'); if (apiKeyCount) { apiKeyCount.textContent = '0'; apiKeyCount.dataset.value = '0' }
    oauthCutoffDueAt = Date.parse(submitted.startedAt) + durationSeconds * 1000
    $('#oauth-api-key-restore').disabled = false
    renderOauthApiKeyCutoffCountdown()
    button.classList.remove('is-loading')
    if (buttonLabel) buttonLabel.textContent = 'API Key 已切断'
    void loadOauthCost({ refresh: true }).catch(() => null)
    if (oauthCutoffCountdownTimer !== null) clearInterval(oauthCutoffCountdownTimer)
    oauthCutoffCountdownTimer = setInterval(renderOauthApiKeyCutoffCountdown, 1000)
    for (;;) {
      const status = await requestJson(`/api/oauth/api-key-cutoff/${encodeURIComponent(submitted.workflowId)}`)
      if (status.terminal) {
        if (status.state !== 'completed') throw new Error(status.error ?? `切断作业${status.state ?? '失败'}`)
        if (status.result?.ok === false) throw new Error(status.result.error ?? 'API Key 恢复失败')
        $('#oauth-api-key-cutoff-state').textContent = `已恢复 API Key 调度 · 恢复 ${status.result?.restoredCount ?? 0} 个`
        oauthCutoffDueAt = null
        clearInterval(oauthCutoffCountdownTimer)
        oauthCutoffCountdownTimer = null
        await loadOauthCost({ refresh: true })
        await loadOauthCutoffHistory()
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  } catch (error) {
    $('#oauth-api-key-cutoff-state').textContent = error instanceof Error ? error.message : String(error)
    oauthCutoffDueAt = null
    if (oauthCutoffCountdownTimer !== null) clearInterval(oauthCutoffCountdownTimer)
    oauthCutoffCountdownTimer = null
    const failedLabel = error instanceof Error ? error.message : String(error)
    const failed = readOauthCutoffLogs().map((item) => item.result === 'pending' ? { ...item, result: 'failed', resultLabel: failedLabel } : item)
    saveOauthCutoffLogs(failed); renderOauthCutoffLogs()
    await loadOauthCost({ refresh: true }).catch(() => null)
  } finally {
    oauthCutoffRunning = false
    $('#oauth-api-key-restore').disabled = false
    button.disabled = false
    button.classList.remove('is-loading')
    if (buttonLabel) buttonLabel.textContent = '临时切断 API Key'
  }
}

async function restoreOauthApiKeysNow() {
  const button = $('#oauth-api-key-restore')
  button.disabled = true
  button.classList.add('is-loading')
  try {
    const result = await requestJson('/api/oauth/api-key-cutoff/restore', { method: 'POST' })
    $('#oauth-api-key-cutoff-state').textContent = result.signaledCount > 0
      ? `已向 ${result.signaledCount} 个切断作业发送立即恢复请求…`
      : '当前没有运行中的 API Key 切断作业'
  } catch (error) {
    button.disabled = false
    $('#oauth-api-key-cutoff-state').textContent = error instanceof Error ? error.message : String(error)
  } finally {
    button.classList.remove('is-loading')
    if (!oauthCutoffRunning) button.disabled = false
  }
}

export async function oauthCostPage() {
  const cutoffControls = document.querySelector('.oauth-cutoff-controls')
  if (cutoffControls && !$('#external-cutoff-run')) cutoffControls.insertAdjacentHTML('beforeend', '<label><span>外部断流测试账号</span><input id="external-cutoff-account" type="number" min="1" step="1" placeholder="账号 ID" /></label><label class="toggle-field"><input id="external-cutoff-live" type="checkbox" /><span>允许真实切断</span></label><button id="external-cutoff-run" class="query-command" type="button"><span class="query-spinner" aria-hidden="true"></span><span>执行断流匹配</span></button><small id="external-cutoff-state" class="oauth-cutoff-state" aria-live="polite">默认 dryrun，只记录切断和恢复</small>')
  renderOauthCutoffLogs()
  renderExternalCutoffLogs()
  $('#external-cutoff-run')?.addEventListener('click', () => void runExternalCutoff())
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
      await loadOauthCost({ refresh: true })
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
    event.preventDefault(); oauthPage = 1; oauthArchivedPage = 1; await loadOauthCost({ refresh: true })
  })
  $('#oauth-prev').addEventListener('click', async () => { oauthPage -= 1; await loadOauthCost({ refresh: true }) })
  $('#oauth-next').addEventListener('click', async () => { oauthPage += 1; await loadOauthCost({ refresh: true }) })
  $('#oauth-archived-prev').addEventListener('click', async () => { oauthArchivedPage -= 1; await loadOauthCost({ refresh: true }) })
  $('#oauth-archived-next').addEventListener('click', async () => { oauthArchivedPage += 1; await loadOauthCost({ refresh: true }) })
  $('#oauth-api-key-cutoff').addEventListener('click', () => void cutoffOauthApiKeys())
  $('#oauth-api-key-restore').addEventListener('click', () => void restoreOauthApiKeysNow())
  $('#oauth-runtime-sample').addEventListener('click', async () => {
    const button = $('#oauth-runtime-sample'); button.disabled = true; button.classList.add('is-loading')
    try {
      const submitted = await requestJson('/api/oauth/runtime-sample', { method: 'POST' })
      for (;;) {
        const status = await requestJson(`/api/oauth/runtime-sample/${encodeURIComponent(submitted.workflowId)}`)
        if (status.terminal) { if (status.state !== 'completed') throw new Error(status.error ?? '采样失败'); await loadOauthCost({ refresh: true }); break }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    } catch (error) { $('#oauth-cost-state').textContent = error instanceof Error ? error.message : String(error) }
    finally { button.disabled = false; button.classList.remove('is-loading') }
  })
  await loadOauthCost()
  startOauthCutoffHistoryRefresh()
  scheduleOauthCostRefresh()
}

export async function accountImportPage() {
  const options = await requestJson('/api/account-import/options')
  const defaults = options.defaults
  const confirmDialog = $('#import-plan-confirm-dialog')
  const confirmForm = $('#import-plan-confirm-form')
  const confirmButton = $('#import-confirm-submit')
  $('#import-priority').value = defaults.priority
  $('#import-capacity').value = defaults.capacity
  $('#import-rate-multiplier').value = defaults.rateMultiplier
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
    $('#import-submit').disabled = true
    $('#import-platform-state').textContent = zip ? '正在解析 ZIP、合并 JSON 并识别账号数量' : '正在聚合 JSON 并识别账号数量'
    try {
      const preview = await requestJson('/api/account-import/preview', {
        method: 'POST', body: JSON.stringify({ content: importContent, inputFormat: importInputFormat }),
      }, 30000)
      if (sequence !== previewSequence) return
      importPreview = preview
      if (!zip) importContent = preview.content
      $('#import-json').value = JSON.stringify(JSON.parse(preview.content), null, 2)
      $('#file-state').textContent = `${file.name} · ${number(file.size)} bytes · ${preview.accountCount} 个账号`
      applyDetectedPlatform()
      updateUnitCostFromTotal()
    } catch (error) {
      if (sequence !== previewSequence) return
      importPreview = null
      if (zip) $('#import-json').value = ''
      $('#file-state').textContent = `${file.name} · ${zip ? 'ZIP' : 'JSON'} 解析失败`
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
  zone.addEventListener('click', (event) => {
    event.preventDefault()
    if (event.target === fileInput) return
    fileInput.click()
  })
  fileInput.addEventListener('click', (event) => event.stopPropagation())
  zone.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    fileInput.click()
  })
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
      : (sharedProxyId ? ` · 整批共用 Proxy #${sharedProxyId}` : ' · 直连（无账号级 Proxy）')
    const outcome = result ? ` · 新建 ${result.createdIds?.length ?? 0} · 更新 ${result.updatedIds?.length ?? 0} · 跳过 ${result.skippedIds?.length ?? result.skipped ?? 0} · 失败 ${result.failed ?? 0}${proxyOutcome}` : ''
    const accounting = job.accounting ? ` · 已记账 ${job.accounting.recordedCount} 个 / ${cny(job.accounting.totalCostCny)}` : ''
    const source = job.source?.format === 'zip' ? `ZIP ${job.source.jsonFileCount} 个 JSON · 包内去重 ${job.source.duplicateAccountCount}` : 'JSON'
    const platform = job.source?.platform === 'grok' ? 'Grok' : 'GPT'
    const proxyPolicy = Number(job.settings.sourceProxyId) === 0 ? '直连（无账号级 Proxy）' : `代理池基准 #${job.settings.sourceProxyId}`
    $('#import-summary').textContent = `${source} · ${platform} · ${job.accountCount} 个账号 · SHA256 ${job.fingerprint} · 类型 ${job.settings.planType.toUpperCase()} · 单价 ${cny(job.settings.unitCostCny)} / 个 · 优先级 ${job.settings.priority} · 容量 ${job.settings.capacity} · 负载因子 ${job.settings.rateMultiplier} · ${labels} · ${proxyPolicy}${outcome}${accounting}`
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
      const rateMultiplier = Number($('#import-rate-multiplier').value)
      if (!Number.isInteger(rateMultiplier) || rateMultiplier < 1 || rateMultiplier > 1000000) throw new Error('负载因子必须为 1 至 1000000 的整数')
      const response = await requestJson('/api/account-import/jobs', { method: 'POST', body: JSON.stringify({
        content: importInputFormat === 'zip' ? importContent : $('#import-json').value, inputFormat: importInputFormat,
        priority: Number($('#import-priority').value), capacity: Number($('#import-capacity').value),
        rateMultiplier,
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
  $('#import-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!importPreview) {
      try {
        const content = importInputFormat === 'zip' ? importContent : $('#import-json').value
        const preview = await requestJson('/api/account-import/preview', {
          method: 'POST', body: JSON.stringify({ content, inputFormat: importInputFormat }),
        }, 30000)
        importPreview = preview
        importContent = preview.content
        $('#import-json').value = JSON.stringify(JSON.parse(preview.content), null, 2)
        applyDetectedPlatform()
        updateUnitCostFromTotal()
      } catch (error) {
        $('#import-platform-state').textContent = error instanceof Error ? error.message : String(error)
        return
      }
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

export async function upstreamsPage() {
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
    applyUpstreamValuationPolicy(options.valuation)
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
      const displayName = displayAccountName(row.name, row.baseUrl)
      const manualRate = row.rateCnyPerApiUsd == null ? '—' : `¥${number(row.rateCnyPerApiUsd, 6)}`
      const detectedRate = multiplier.primary === '未知' ? '探测 —' : `探测 ${multiplier.primary}`
      return `<tr class="upstream-row" data-id="${escapeHtml(row.id)}" tabindex="0" role="button" aria-label="编辑 ${escapeHtml(displayName)}">
        <td class="upstream-id-cell"><b><a class="upstream-url-link" href="${escapeHtml(row.baseUrl)}" target="_blank" rel="noreferrer">${escapeHtml(displayName)}</a></b><small>#${escapeHtml(row.id)} · ${escapeHtml(row.baseUrl)}</small></td>
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
    $('#upstream-edit-summary').textContent = `${displayAccountName(row.name, row.baseUrl)} · ${row.status === 'active' && row.schedulable ? '当前可调度' : '当前不可调度'} · 已充值 ${cny(row.rechargeCny)}`
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
    $('#upstream-create-state').textContent = '创建时将自动配置号池、直连（无账号级 Proxy）、切号模板，以及账号专属私有探活分组和 API Key。'
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
