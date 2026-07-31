import { shouldApplyScorePayload } from './score-display-freshness.js'

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
    ['scores', '/scores', '账号评分'],
    ['ranking', '/ranking', '用户用量'],
    ['lottery', '/lottery', '额度抽奖'],
    ['operations', '/operations', '经营管理'],
    ['account-import', '/account-import', '账号导入'],
    ['upstreams', '/upstreams', '上游管理'],
  ]
  mount.innerHTML = `<header class="topbar">
    <a class="brand" href="/scores"><span class="brand-mark">AS</span><span><b>ApiState</b><small>Sub2API Operations</small></span></a>
    <nav>${links.map(([id, href, label]) => `<a href="${href}"${page === id ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <div class="topbar-actions"><span class="live-sign"><i></i> PK01</span><button id="logout" class="text-command" type="button">退出</button></div>
  </header>`
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
let scoreRefreshedAt = null
let scoreNextRefreshAt = null
let priorityPlanRows = new Map()
let priorityPlanVisible = false
let activeScoreProfile = 'codex'
let scorePage = 1
const scorePageSize = 10

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
  $('#score-countdown').textContent = countdown(scoreNextRefreshAt)
}

function renderScoreRows() {
  const term = ($('#score-filter')?.value ?? '').trim().toLowerCase()
  const filteredRows = scoreRowsForActiveProfile()
    .filter((row) => `${row.accountName ?? ''} ${row.groupName ?? ''} ${(row.groupNames ?? []).join(' ')}`.toLowerCase().includes(term))
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
    return `<tr class="${available ? '' : 'score-row-unavailable'}">
      <td class="account-cell"><b>${escapeHtml(row.accountName)}</b><small>#${escapeHtml(row.accountId)}</small></td>
      <td>${groupLabels(row)}</td>
      <td>${number(row.priority)}</td>
      <td>${desiredPriority === null ? '—' : number(desiredPriority)}</td>
      <td>${priorityDelta === null ? '—' : signed(priorityDelta)}</td>
      <td><span class="score-value ${gradeClass(row.grade)}">${number(row.score, 1)}</span></td>
      <td>${costRate == null ? '—' : number(costRate, 4)}</td>
      <td>${escapeHtml(row.grade ?? '—')}</td>
      <td>${escapeHtml(row.confidence ?? '—')}</td>
      <td>${number(row.observedAttempts)}</td>
      <td>${percent(row.failureRate)}</td>
      <td>${row.ttftP95Ms == null ? '—' : `${number(row.ttftP95Ms)} ms`}</td>
      <td>${compact(usage.requestCount)}</td>
      <td>${compact(usage.tokenCount)}</td>
      <td class="usd-cell">${usd(usage.apiAmountUsd)}</td>
      <td>${number(row.failoverRequests)} / ${number(row.failoverRecovered)}</td>
      <td class="availability-cell"><span class="availability ${available ? 'is-up' : 'is-down'}">${available ? '可用' : '不可用'}</span>${available ? '' : `<small title="${escapeHtml(reasonDetail)}">${escapeHtml(reason.label ?? '原因未记录')}</small>`}</td>
    </tr>`
  }).join('') : '<tr><td colspan="17" class="empty">没有匹配的账号</td></tr>'
  const range = filteredRows.length === 0 ? '0 条' : `${start + 1}-${Math.min(start + scorePageSize, filteredRows.length)} / ${number(filteredRows.length)} 条`
  $('#score-page').textContent = `${scorePage} / ${totalPages} · ${range}`
  $('#score-prev').disabled = scorePage <= 1
  $('#score-next').disabled = scorePage >= totalPages
}

function renderScoreMetrics(data = {}) {
  const rows = scoreRowsForActiveProfile()
  const groups = [...new Set(rows.flatMap((row) =>
    Array.isArray(row.groupNames) ? row.groupNames : [row.groupName].filter(Boolean)
  ))]
  $('#metric-accounts').textContent = number(rows.length)
  $('#metric-groups').textContent = number(groups.length)
  $('#metric-good').textContent = number(rows.filter((row) => Number(row.score) >= 80).length)
  $('#metric-risk').textContent = number(rows.filter((row) => Number(row.score) < 60).length)
  if (data.window || data.recentCallLimit) {
    $('#metric-window').textContent = data.window ?? `最近 ${number(data.recentCallLimit)} 次`
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

async function scoresPage() {
  const select = $('#score-call-limit')
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
  $('#query-scores').addEventListener('click', () => void refreshPriorityState().catch(() => undefined))
  $('#refresh-scores').addEventListener('click', async () => {
    const button = $('#refresh-scores')
    button.disabled = true
    try {
      await refreshPriorityState()
    }
    catch (error) { $('#score-updated-time').textContent = error instanceof Error ? error.message : String(error) }
    finally { button.disabled = false }
  })
  const initial = await requestJson('/api/scores')
  const options = initial.availableCallOptions ?? []
  const preferredLimit = options.includes(1000) ? 1000 : options[0]
  select.innerHTML = options.map((value) => `<option value="${value}"${value === preferredLimit ? ' selected' : ''}>最近 ${number(value)} 次</option>`).join('')
  renderScores(initial)
  await setupPriorityPanel(options)
  setInterval(renderRefreshClock, 1000)
  setInterval(async () => {
    if (!document.hidden) {
      const data = await requestJson('/api/scores').catch(() => null)
      if (data) renderScores(data)
    }
  }, 30000)
}

async function rankingPage() {
  const data = await requestJson('/api/ranking')
  const ranking = data.ranking
  $('#ranking-range').textContent = `${ranking.startDate} 至 ${ranking.endDate}`
  $('#ranking-cost').innerHTML = usd(ranking.totals.actualCost)
  $('#ranking-requests').textContent = compact(ranking.totals.requests)
  $('#ranking-tokens').textContent = compact(ranking.totals.tokens)
  $('#ranking-body').innerHTML = ranking.rows.length ? ranking.rows.map((row) => `<tr><td>${String(row.rank).padStart(2, '0')}</td><td class="account-cell"><b>${escapeHtml(row.displayName)}</b></td><td class="usd-cell">${usd(row.actualCost)}</td><td>${compact(row.requests)}</td><td>${compact(row.tokens)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">当前窗口暂无用量</td></tr>'
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
const operationsSnapshotKey = 'apistate.operations.snapshot.v1'
let cashPage = 1
let auditPage = 1
let oauthPage = 1
let oauthArchivedPage = 1
let oauthRefreshTimer = null
let oauthRefreshCountdownTimer = null
let oauthRefreshDueAt = null
let oauthCostLoading = false
let procurementPage = 1
let procurementBudget = null
const oauthRefreshIntervalStorageKey = 'apistate.operations.oauth-refresh-interval.v1'
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
  const button = $('#query-scores')
  const select = $('#score-call-limit')
  const limit = Number(select.value)
  button.disabled = true
  select.disabled = true
  $('#score-state').textContent = '查询中'
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
  const data = await requestJson('/api/operations/priority-history')
  priorityHistoryRecords = data.records ?? []
  renderPriorityHistoryPage()
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
      const plan = await requestJson('/api/operations/priority-plans', {
        method: 'POST', body: JSON.stringify({ recentCallLimit: Number($('#score-call-limit').value) }),
      }, 90000)
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
    planProgress('已提交确认，后端 API 正在批量写入；随后通过 PostgreSQL 直连回读')
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

function renderOauthCost(data) {
  const pool = data.pool ?? { total: data.total ?? {}, groups: data.groups ?? [] }
  const total = pool.total ?? {}
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
  const expectedRemaining = (row) => row.remainingExpectedApiAmountUsd ?? row.remainingIdealApiAmountUsd
  const expectedUnitCost = (row) => row.expectedCnyPerApiUsd ?? row.idealCnyPerApiUsd
  const outputProgress = (row) => {
    const actual = Number(row.apiAmountUsd)
    const expected = Number(expectedAmount(row))
    if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected <= 0) {
      return { percent: '—', width: '0', className: 'is-empty', value: null }
    }
    const ratio = actual / expected
    return {
      percent: `${number(ratio * 100, 1)}%`,
      width: Math.min(100, Math.max(0, ratio * 100)).toFixed(2),
      className: ratio > 1 ? 'is-over' : '',
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
  outputProgressBar.setAttribute('aria-valuetext', totalOutputProgress.value === null ? '缺少预期产出配置' : `已产出占预期产出 ${totalOutputProgress.percent}`)
  if (totalOutputProgress.value === null) outputProgressBar.removeAttribute('aria-valuenow')
  else outputProgressBar.setAttribute('aria-valuenow', totalOutputProgress.value.toFixed(1))
  const totalExpectedAmount = expectedAmount(total)
  const totalExpectedRemaining = expectedRemaining(total)
  $('#oauth-cost-output-progress-label').textContent = totalExpectedAmount == null
    ? '已产出 / 预期 —'
    : `已产出 / 预期 ${usdText(total.apiAmountUsd, 2)} / ${usdText(totalExpectedAmount, 2)} · ${totalOutputProgress.percent}`
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
  $('#oauth-cost-state').textContent = `当前号池核算 · 全历史用量${exclusionLabel}${warningLabel} · ${data.complete ? '数据完整' : '有数据缺口'} · ${number(data.databaseQueries)} 次数据库查询`
  const labels = { k12: 'K12', plus: 'Plus', free: 'Free', team: 'Team' }
  const archived = data.archived ?? { groups: [] }
  const statusDistributionCell = (row, statusSource = row) => {
    if (row.scope === 'archived') return '<td class="oauth-status-distribution"><span class="oauth-status-unavailable">—</span></td>'
    const counts = statusCounts(statusSource)
    const total = counts.normal + counts.rateLimited + counts.error
    if (total === 0) return '<td class="oauth-status-distribution"><span class="oauth-status-unavailable">—</span></td>'
    return `<td class="oauth-status-distribution">
      <div class="oauth-status-visual" role="group" aria-label="账号状态分布">${statusDonutMarkup(statusSource)}<div class="oauth-status-legend"><span class="oauth-status-normal">正常 ${counts.normal}</span><span class="oauth-status-rate-limited">限流 ${counts.rateLimited}</span><span class="oauth-status-error">错误 ${counts.error}</span></div></div>
    </td>`
  }
  const outputCell = (row) => {
    const progress = outputProgress(row)
    const rowExpectedAmount = expectedAmount(row)
    const configuredExpectedLabel = row.planType === 'total'
      ? '正常账号按各类型预期'
      : `正常号按 ${usd(row.expectedApiUsdPerAccount ?? row.idealApiUsdPerAccount, 2)} / 号`
    const expectedLabel = rowExpectedAmount == null
      ? '预期产出缺少类型配置'
      : row.expectedOutputBasis === 'status-adjusted'
        ? `${configuredExpectedLabel}，限流/错误按当前产出`
        : row.planType === 'total' ? '预期总产出' : `预期 ${usd(row.expectedApiUsdPerAccount ?? row.idealApiUsdPerAccount, 2)} / 号`
    const progressAttributes = progress.value === null
      ? 'aria-valuetext="缺少预期产出配置"'
      : `aria-valuenow="${progress.value.toFixed(1)}"`
    return `<td class="oauth-output-cell">
      <div class="oauth-output-values"><span class="oauth-output-actual">${usd(row.apiAmountUsd, 2)}</span><span class="oauth-output-separator">/</span><span class="oauth-output-ideal">${usd(rowExpectedAmount, 2)}</span><b class="oauth-output-percent ${progress.className}">(${progress.percent})</b></div>
      <div class="oauth-output-progress ${progress.className}" role="progressbar" aria-label="已产出占预期产出" aria-valuemin="0" aria-valuemax="100" ${progressAttributes}><span style="width:${progress.width}%"></span></div>
      <small class="cost-breakdown">${expectedLabel}</small>
    </td>`
  }
  const renderRow = (row, scopeLabel, isTotal = false) => {
    const averageUnitCostCny = row.averageUnitCostCny == null && isTotal && Number(row.accountCount) > 0
      ? Number(row.netAcquisitionCostCny) / Number(row.accountCount)
      : row.averageUnitCostCny
    return `<tr class="${isTotal ? 'oauth-total-row' : ''}">
      <td><b>${scopeLabel}</b></td><td><b>${escapeHtml(isTotal ? '合计' : (labels[row.planType] ?? row.planType))}</b></td><td>${number(row.accountCount)}</td>
      <td>${number(row.usageAccountCount)}</td>${statusDistributionCell(row, isTotal ? health : row)}
      <td>${cny(row.netAcquisitionCostCny)}<small class="cost-breakdown">毛 ${cny(row.grossAcquisitionCostCny)} · 退款 ${cny(row.procurementRefundCny)}</small></td>
      <td>${averageUnitCostCny == null ? '—' : cny(averageUnitCostCny)}${isTotal ? '' : '<small class="cost-breakdown">净采购成本 / 号</small>'}</td>
      ${outputCell({ ...row, planType: isTotal ? 'total' : row.planType })}
      <td>${row.cnyPerApiUsd == null ? '—' : `¥${number(row.cnyPerApiUsd, 5)}`}</td><td>${expectedUnitCost(row) == null ? '—' : `¥${number(expectedUnitCost(row), 5)}`}</td>
      <td>${number(row.requestCount)}</td><td>${number(row.tokenCount)}</td>
    </tr>`
  }
  const renderRows = (rows, target, emptyText, scopeLabel, total) => {
    const rowMarkup = rows.map((row) => renderRow(row, scopeLabel)).join('')
    const totalMarkup = total && number(total.accountCount) > 0 ? renderRow(total, `${scopeLabel}合计`, true) : ''
    $(target).innerHTML = rows.length ? rowMarkup + totalMarkup : `<tr><td colspan="12" class="empty">${emptyText}</td></tr>`
  }
  renderRows(pool.groups ?? [], '#oauth-cost-body', '当前号池没有 OAuth 账号或采购记录', '当前号池', total)
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
  renderRows(archived.groups ?? [], '#oauth-archived-body', '当前没有已归档 OAuth 采购记录', '已归档', archivedTotal)
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
    const data = await requestJson(`/api/operations/oauth-cost?page=${oauthPage}&archivedPage=${oauthArchivedPage}`, {}, 60000)
    renderOauthCost(data)
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
  const refreshInterval = $('#oauth-cost-refresh-interval')
  const storedRefreshInterval = readOauthRefreshInterval()
  if (storedRefreshInterval !== null) refreshInterval.value = String(storedRefreshInterval)
  refreshInterval.addEventListener('change', () => {
    writeOauthRefreshInterval(refreshInterval.value)
    scheduleOauthCostRefresh()
  })
  $('#oauth-cost-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    oauthPage = 1
    oauthArchivedPage = 1
    await loadOauthCost()
  })
  $('#oauth-prev').addEventListener('click', async () => { oauthPage -= 1; await loadOauthCost() })
  $('#oauth-next').addEventListener('click', async () => { oauthPage += 1; await loadOauthCost() })
  $('#oauth-archived-prev').addEventListener('click', async () => { oauthArchivedPage -= 1; await loadOauthCost() })
  $('#oauth-archived-next').addEventListener('click', async () => { oauthArchivedPage += 1; await loadOauthCost() })
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
  await Promise.all([loadOperations({ showCached: true }), loadOauthCost()])
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
  $('#import-priority').value = defaults.priority
  $('#import-capacity').value = defaults.capacity
  $('#import-proxy').value = defaults.sourceProxyId
  $('#import-per-account-proxy').checked = defaults.perAccountProxy === true
  const planType = $('#import-plan-type')
  planType.innerHTML = options.planTypes.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')
  planType.value = defaults.planType
  let planTypeManuallySelected = false
  planType.addEventListener('change', () => { planTypeManuallySelected = true })
  $('#import-unit-cost').addEventListener('input', () => {
    if (planTypeManuallySelected) return
    const cost = Number($('#import-unit-cost').value)
    planType.value = Number.isFinite(cost) && cost > 0
      ? (cost < defaults.freeCostThresholdCny ? 'free' : cost > defaults.plusCostThresholdCny ? 'plus' : 'k12')
      : defaults.planType
  })
  $('#import-groups').innerHTML = options.groups.map((group) => `<label><input type="checkbox" value="${group.id}" ${defaults.groupIds.includes(group.id) ? 'checked' : ''}/><span>${escapeHtml(group.name)} <b>#${group.id}</b></span></label>`).join('')
  const fileInput = $('#import-file')
  const zone = $('#drop-zone')
  let importInputFormat = 'json'
  let importContent = ''
  const bytesToBase64 = (bytes) => {
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    }
    return btoa(binary)
  }
  const loadFile = async (file) => {
    if (!file) return
    const zip = file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip'
    importInputFormat = zip ? 'zip' : 'json'
    importContent = zip ? bytesToBase64(new Uint8Array(await file.arrayBuffer())) : await file.text()
    $('#import-json').value = zip ? '' : importContent
    $('#import-json').disabled = zip
    $('#import-json').placeholder = zip ? 'ZIP 将在服务端安全合并，二进制内容不会回显' : '粘贴 Sub2API 导出的 JSON'
    $('#file-state').textContent = `${file.name} · ${number(file.size)} bytes`
  }
  $('#import-json').addEventListener('input', () => {
    if ($('#import-json').disabled) return
    importInputFormat = 'json'
    importContent = $('#import-json').value
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
    $('#import-summary').textContent = `${source} · ${job.accountCount} 个账号 · SHA256 ${job.fingerprint} · 类型 ${job.settings.planType.toUpperCase()} · 单价 ${cny(job.settings.unitCostCny)} / 个 · 优先级 ${job.settings.priority} · 容量 ${job.settings.capacity} · ${labels} · 代理池基准 #${job.settings.sourceProxyId}${outcome}${accounting}`
    $('#import-logs').innerHTML = job.logs.length ? job.logs.map((log) => `<li data-state="${escapeHtml(log.state)}"><time>${time(log.timestamp)}</time><b>${escapeHtml(log.stage)}</b><span>${escapeHtml(log.message)}</span></li>`).join('') : '<li class="empty">等待作业启动</li>'
    $('#import-logs').scrollTop = $('#import-logs').scrollHeight
  }
  $('#import-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const button = $('#import-submit'); button.disabled = true
    try {
      const groupIds = [...document.querySelectorAll('#import-groups input:checked')].map((input) => Number(input.value))
      const response = await requestJson('/api/account-import/jobs', { method: 'POST', body: JSON.stringify({
        content: importInputFormat === 'zip' ? importContent : $('#import-json').value, inputFormat: importInputFormat,
        priority: Number($('#import-priority').value), capacity: Number($('#import-capacity').value),
        groupIds, sourceProxyId: Number($('#import-proxy').value),
        perAccountProxy: $('#import-per-account-proxy').checked,
        unitCostCny: Number($('#import-unit-cost').value), planType: planType.value, confirm: true,
      }) }, 30000)
      let job = response.job; renderJob(job)
      while (job.state === 'queued' || job.state === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        job = (await requestJson(`/api/account-import/jobs/${encodeURIComponent(job.id)}`)).job; renderJob(job)
      }
    } finally { button.disabled = false }
  })
}

let upstreamPage = 1
let upstreamSearch = ''
let activeUpstream = null

function upstreamStatus(row) {
  if (row.status === 'active' && row.schedulable) return { label: '可调度', className: 'is-available' }
  if (row.status === 'active') return { label: '已停调度', className: 'is-limited' }
  return { label: row.status || '异常', className: 'is-error' }
}

function upstreamGroupMarkup(row) {
  const ids = Array.isArray(row.groupIds) ? row.groupIds : []
  const names = Array.isArray(row.groupNames) ? row.groupNames : []
  if (!ids.length && !names.length) return '<span>未分组</span>'
  return `<span>${escapeHtml(names.join('、') || '分组')} · ${escapeHtml(ids.map((id) => `#${id}`).join('、'))}</span>`
}

function upstreamOperationId(prefix) {
  return `${prefix}-${typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

async function upstreamsPage() {
  const createDialog = $('#upstream-create-dialog')
  const editDialog = $('#upstream-edit-dialog')
  const setState = (message, state = '') => {
    $('#upstream-state').textContent = message
    $('#upstream-state').dataset.state = state
  }
  let lastUpstreamRows = []
  let createOperationId = null
  let editRechargeOperationId = null
  const render = (data) => {
    const rows = Array.isArray(data.accounts) ? data.accounts : []
    lastUpstreamRows = rows
    $('#upstream-total').textContent = number(data.total)
    $('#upstream-available').textContent = `${number(data.availableTotal)} / ${number(data.total)}`
    $('#upstream-recharged').textContent = cny(data.rechargeTotalCny)
    $('#upstream-page-metric').textContent = `${number(data.page)} / ${number(data.totalPages)}`
    $('#upstream-query-state').textContent = data.search ? `筛选：${data.search} · 当前页 ${number(rows.length)} 条` : `当前页 ${number(rows.length)} 条 · 点击行编辑`
    $('#upstream-body').innerHTML = rows.length ? rows.map((row) => {
      const status = upstreamStatus(row)
      return `<tr class="upstream-row" data-id="${escapeHtml(row.id)}" tabindex="0" role="button" aria-label="编辑 ${escapeHtml(row.name)}">
        <td class="upstream-id-cell"><b>${escapeHtml(row.name)}</b><small>#${escapeHtml(row.id)}</small></td>
        <td class="upstream-url" title="${escapeHtml(row.baseUrl)}">${escapeHtml(row.baseUrl)}</td>
        <td class="upstream-muted">${escapeHtml(row.keyPrefix ?? '—')}</td>
        <td>${escapeHtml(row.suffix ?? '—')}</td>
        <td class="upstream-rate">${row.rateCnyPerApiUsd == null ? '—' : `¥${number(row.rateCnyPerApiUsd, 6)}`}</td>
        <td><span class="upstream-status ${status.className}">${status.label}</span><small class="upstream-muted">${escapeHtml(row.status || '—')}</small></td>
        <td><div class="upstream-groups">${upstreamGroupMarkup(row)}</div><small class="upstream-muted">Proxy #${escapeHtml(row.proxyId ?? '—')}</small></td>
        <td>${cny(row.rechargeCny)}<small class="upstream-muted">${number(row.rechargeCount)} 笔</small></td>
        <td class="upstream-muted">${time(row.updatedAt ?? row.createdAt)}</td>
      </tr>`
    }).join('') : '<tr><td colspan="9" class="empty">没有符合条件的 API-key 上游</td></tr>'
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
      setState('已更新', 'ready')
    } catch (error) {
      setState('读取失败', 'unavailable')
      $('#upstream-query-state').textContent = error instanceof Error ? error.message : String(error)
      $('#upstream-body').innerHTML = `<tr><td colspan="9" class="empty">${escapeHtml(error instanceof Error ? error.message : String(error))}</td></tr>`
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
    editDialog.showModal()
  }
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
    $('#upstream-create-state').textContent = '创建时将使用默认优先级 1、容量 16、混池 #2、自用 #3、Proxy #3 和切号模板。'
    $('#upstream-create-state').removeAttribute('data-state')
    createOperationId = upstreamOperationId('upstream-create')
    createDialog.showModal()
  })
  createDialog.addEventListener('close', () => {
    $('#upstream-create-api-key').value = ''
    createOperationId = null
  })
  $('#upstream-create-form').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return
    event.preventDefault()
    const button = $('#upstream-create-submit')
    button.disabled = true
    $('#upstream-create-state').textContent = '正在调用 runtime 创建并绑定分组，API key 不会回显…'
    try {
      const operation = createOperationId ?? (createOperationId = upstreamOperationId('upstream-create'))
      const rechargeValue = $('#upstream-create-recharge').value.trim()
      const result = await requestJson('/api/upstreams', {
        method: 'POST',
        headers: { 'Idempotency-Key': operation },
        body: JSON.stringify({
          baseUrl: $('#upstream-create-base-url').value,
          apiKey: $('#upstream-create-api-key').value,
          suffix: $('#upstream-create-suffix').value,
          rateCnyPerApiUsd: Number($('#upstream-create-rate').value),
          rechargeCny: rechargeValue ? Number(rechargeValue) : undefined,
          operationId: operation,
        }),
      }, 300000)
      $('#upstream-create-state').textContent = `创建成功：账号 #${result.account?.id ?? '—'}${result.accounting?.mutation ? `，已记账 ${cny(result.accounting.amountCny)}` : ''}`
      $('#upstream-create-state').dataset.state = 'success'
      $('#upstream-create-api-key').value = ''
      createOperationId = null
      await load()
      setTimeout(() => { if (createDialog.open) createDialog.close() }, 350)
    } catch (error) {
      $('#upstream-create-state').textContent = error instanceof Error ? error.message : String(error)
      $('#upstream-create-state').dataset.state = 'error'
    } finally { button.disabled = false }
  })
  $('#upstream-edit-form').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return
    event.preventDefault()
    if (!activeUpstream) return
    const button = $('#upstream-edit-submit')
    button.disabled = true
    $('#upstream-edit-state').textContent = '正在保存调整…'
    $('#upstream-edit-state').removeAttribute('data-state')
    try {
      const id = Number(activeUpstream.id)
      await requestJson(`/api/upstreams/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ suffix: $('#upstream-edit-suffix').value, rateCnyPerApiUsd: Number($('#upstream-edit-rate').value) }),
      })
      const rechargeValue = $('#upstream-edit-recharge').value.trim()
      let recharge = null
      if (rechargeValue) {
        recharge = await requestJson(`/api/upstreams/${id}/recharge`, {
          method: 'POST',
          headers: { 'Idempotency-Key': editRechargeOperationId ?? upstreamOperationId(`upstream-recharge-${id}`) },
          body: JSON.stringify({ amountCny: Number(rechargeValue) }),
        }, 300000)
      }
      $('#upstream-edit-state').textContent = recharge?.recovered ? '调整与充值完成，已恢复调度。' : '调整完成。'
      $('#upstream-edit-state').dataset.state = 'success'
      editRechargeOperationId = null
      await load()
      setTimeout(() => { if (editDialog.open) editDialog.close() }, 350)
    } catch (error) {
      $('#upstream-edit-state').textContent = error instanceof Error ? error.message : String(error)
      $('#upstream-edit-state').dataset.state = 'error'
    } finally { button.disabled = false }
  })
  await load()
}

async function boot() {
  if (page === 'login') return await loginPage()
  shell()
  if (page === 'scores') return await scoresPage()
  if (page === 'ranking') return await rankingPage()
  if (page === 'lottery') return await lotteryPage()
  if (page === 'operations') return await operationsPage()
  if (page === 'account-import') return await accountImportPage()
  if (page === 'upstreams') return await upstreamsPage()
}

boot().catch((error) => {
  const target = $('.workspace') ?? $('main')
  if (target) target.insertAdjacentHTML('afterbegin', `<div class="fatal-state">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`)
})
