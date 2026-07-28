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
  const rows = scoreRows.filter((row) => `${row.accountName} ${row.groupName}`.toLowerCase().includes(term))
  $('#score-body').innerHTML = rows.length ? rows.map((row) => {
    const usage = row.usage ?? {}
    const planRow = priorityPlanRows.get(String(row.accountId))
    const desiredPriority = priorityPlanVisible && planRow ? Number(planRow.desiredPriority) : null
    const priorityDelta = desiredPriority === null ? null : desiredPriority - Number(row.priority)
    const costRate = planRow?.costRateCnyPerApiUsd ?? usage.costRateCnyPerApiUsd
    return `<tr>
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
      <td>${number(row.failoverRecovered)} / ${number(row.failoverRequests)}</td>
      <td><span class="availability ${(row.currentAvailable ?? row.currentlyAvailable) ? 'is-up' : 'is-down'}">${(row.currentAvailable ?? row.currentlyAvailable) ? '可用' : '不可用'}</span></td>
    </tr>`
  }).join('') : '<tr><td colspan="17" class="empty">没有匹配的账号</td></tr>'
}

function renderScores(data) {
  scoreRows = data.accounts ?? []
  const groups = data.groups ?? [...new Set(scoreRows.flatMap((row) =>
    Array.isArray(row.groupNames) ? row.groupNames : [row.groupName].filter(Boolean)
  ))]
  $('#metric-accounts').textContent = number(scoreRows.length)
  $('#metric-groups').textContent = number(groups.length)
  $('#metric-good').textContent = number(scoreRows.filter((row) => Number(row.score) >= 80).length)
  $('#metric-risk').textContent = number(scoreRows.filter((row) => Number(row.score) < 60).length)
  $('#metric-window').textContent = data.window ?? (data.recentCallLimit ? `最近 ${number(data.recentCallLimit)} 次` : '—')
  const status = data.status ?? (scoreRows.length ? 'ready' : 'unavailable')
  $('#score-state').textContent = ({ ready: '已更新', refreshing: '刷新中', stale: '使用旧快照', unavailable: '暂无快照' })[status] ?? status
  $('#score-state').dataset.state = status
  scoreRefreshedAt = data.refreshedAt ?? data.queryCompletedAt ?? data.collectedAt ?? scoreRefreshedAt
  scoreNextRefreshAt = data.nextRefreshAt ?? scoreNextRefreshAt
  if (data.recentCallLimit && $('#score-call-limit')) $('#score-call-limit').value = String(data.recentCallLimit)
  renderRefreshClock()
  renderScoreRows()
}

async function scoresPage() {
  const select = $('#score-call-limit')
  $('#score-filter').addEventListener('input', renderScoreRows)
  $('#query-scores').addEventListener('click', () => void refreshPriorityState().catch(() => undefined))
  $('#refresh-scores').addEventListener('click', async () => {
    const button = $('#refresh-scores')
    button.disabled = true
    $('#score-state').textContent = '刷新中'
    try {
      renderScores(await requestJson('/api/scores/refresh', { method: 'POST', body: '{}' }, 200000))
      clearPriorityPlan('评分已刷新，请重新生成调整计划')
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

let activePlanId = null
let priorityAutomationExists = false
const operationsSnapshotKey = 'apistate.operations.snapshot.v1'

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

async function loadPriorityHistory() {
  const data = await requestJson('/api/operations/priority-history')
  $('#priority-history-body').innerHTML = data.records?.length ? data.records.map((row) => `<tr>
    <td>${row.profile === 'grok' ? 'Grok' : 'Codex'}</td>
    <td>${time(row.started_at)}</td><td>${row.trigger_type === 'automatic' ? '自动' : '手动'}</td>
    <td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.created_by)}</td>
    <td>${number(row.recent_call_limit)}</td><td>${number(row.changed_count)}</td>
    <td>${time(row.completed_at)}</td>
    <td>${row.duration_ms == null ? '—' : `${number(Number(row.duration_ms) / 1000, 1)} 秒`}</td>
  </tr>`).join('') : '<tr><td colspan="9" class="empty">暂无调整记录</td></tr>'
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
  const yamlRows = [
    ...(ledger.yaml.revenues ?? []).map((row) => ({ ...row, direction: 'income' })),
    ...(ledger.yaml.costs ?? []).map((row) => ({ ...row, direction: 'expense' })),
  ]
  const rows = [
    { source: 'alipay', period: ledger.period, direction: 'income', kind: 'alipay-completed', amountCny: ledger.alipay.revenueCny, description: `${ledger.alipay.completedOrders} 笔已完成订单（已排除管理员测试）`, readOnly: true },
    ...(ledger.manual ?? []), ...yamlRows,
  ]
  $('#cash-body').innerHTML = rows.length ? rows.map((row) => `<tr>
    <td>${row.source === 'yaml' ? 'YAML（只读）' : row.source === 'alipay' ? '支付宝（只读）' : '手工数据库'}</td>
    <td>${escapeHtml(row.occurred_on ?? row.period ?? '—')}</td>
    <td>${row.direction === 'income' ? '收入' : '支出'}</td>
    <td>${escapeHtml(row.category ?? row.kind ?? '—')}</td>
    <td>${cny(row.amount_cny ?? row.amountCny)}</td>
    <td>${escapeHtml(row.description ?? '')}</td>
    <td>${row.voided_at ? '已作废' : '有效'}</td>
    <td>${row.readOnly || row.voided_at ? '—' : `<button class="text-command cash-void" data-id="${escapeHtml(row.id)}" type="button">作废</button>`}</td>
  </tr>`).join('') : '<tr><td colspan="8" class="empty">暂无经营记录</td></tr>'
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
  try {
    localStorage.setItem(operationsSnapshotKey, JSON.stringify({ ledger, audits, refreshedAt: new Date().toISOString() }))
  } catch {
    // 隐私模式可能禁用存储，不影响实时数据渲染。
  }
}

async function loadOperations({ showCached = false } = {}) {
  if (showCached) {
    const cached = readOperationsSnapshot()
    if (cached) renderOperations(cached.ledger, cached.audits)
  }
  const [ledger, audits] = await Promise.all([
    requestJson('/api/operations/ledger'),
    requestJson('/api/operations/audits'),
  ])
  renderOperations(ledger, audits)
  writeOperationsSnapshot(ledger, audits)
}

async function operationsPage() {
  $('#cash-date').value = new Date().toISOString().slice(0, 10)
  $('#cash-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    await requestJson('/api/operations/cash', { method: 'POST', body: JSON.stringify({
      occurredOn: $('#cash-date').value, direction: $('#cash-direction').value,
      category: $('#cash-category').value, amountCny: Number($('#cash-amount').value),
      description: $('#cash-description').value,
    }) })
    event.currentTarget.reset()
    $('#cash-date').value = new Date().toISOString().slice(0, 10)
    await loadOperations()
  })
  $('#procurement-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const result = await requestJson('/api/operations/procurement', {
      method: 'POST', body: JSON.stringify({ budgetCny: Number($('#procurement-budget').value) }),
    }, 90000)
    $('#procurement-body').innerHTML = result.allocations?.length ? result.allocations.map((row) => `<tr>
      <td>${escapeHtml(row.billingSite)}</td><td>${cny(row.amountCny)}</td><td>${cny(row.denominationCny)}</td>
    </tr>`).join('') : `<tr><td colspan="3" class="empty">未分配 ${cny(result.unallocatedCny)}</td></tr>`
    await loadOperations()
  })
  await loadOperations({ showCached: true })
}

async function boot() {
  if (page === 'login') return await loginPage()
  shell()
  if (page === 'scores') return await scoresPage()
  if (page === 'ranking') return await rankingPage()
  if (page === 'lottery') return await lotteryPage()
  if (page === 'operations') return await operationsPage()
}

boot().catch((error) => {
  const target = $('.workspace') ?? $('main')
  if (target) target.insertAdjacentHTML('afterbegin', `<div class="fatal-state">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`)
})
