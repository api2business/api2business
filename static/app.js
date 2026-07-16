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

function gradeClass(value) {
  const grade = String(value ?? '').toLowerCase()
  if (grade === 'excellent' || grade === 'good') return 'grade-good'
  if (grade === 'poor' || grade === 'critical' || grade === 'insufficient') return 'grade-risk'
  return 'grade-mid'
}

function renderScoreRows() {
  const term = ($('#score-filter')?.value ?? '').trim().toLowerCase()
  const rows = scoreRows.filter((row) => `${row.accountName} ${row.groupName}`.toLowerCase().includes(term))
  $('#score-body').innerHTML = rows.length ? rows.map((row) => {
    const usage = row.usage ?? {}
    return `<tr>
      <td class="account-cell"><b>${escapeHtml(row.accountName)}</b><small>#${escapeHtml(row.accountId)}</small></td>
      <td>${escapeHtml(row.groupName)}</td>
      <td>${number(row.priority)}</td>
      <td><span class="score-value ${gradeClass(row.grade)}">${number(row.score)}</span></td>
      <td>${escapeHtml(row.grade ?? '—')}</td>
      <td>${escapeHtml(row.confidence ?? '—')}</td>
      <td>${number(row.observedAttempts)}</td>
      <td>${percent(row.failureRate)}</td>
      <td>${row.ttftP95Ms == null ? '—' : `${number(row.ttftP95Ms)} ms`}</td>
      <td>${compact(usage.requestCount)}</td>
      <td>${compact(usage.tokenCount)}</td>
      <td>${usage.apiAmountUsd == null ? '—' : `$${number(usage.apiAmountUsd, 3)}`}</td>
      <td>${number(row.failoverRecovered)} / ${number(row.failoverRequests)}</td>
      <td><span class="availability ${row.currentlyAvailable ? 'is-up' : 'is-down'}">${row.currentlyAvailable ? '可用' : '不可用'}</span></td>
    </tr>`
  }).join('') : '<tr><td colspan="14" class="empty">没有匹配的账号</td></tr>'
}

function renderScores(data) {
  scoreRows = data.accounts ?? []
  $('#metric-accounts').textContent = number(scoreRows.length)
  $('#metric-groups').textContent = number((data.groups ?? []).length)
  $('#metric-good').textContent = number(scoreRows.filter((row) => Number(row.score) >= 80).length)
  $('#metric-risk').textContent = number(scoreRows.filter((row) => Number(row.score) < 60).length)
  $('#metric-window').textContent = data.window ?? '—'
  $('#score-state').textContent = ({ ready: '已更新', refreshing: '刷新中', stale: '使用旧快照', unavailable: '暂无快照' })[data.status] ?? data.status
  $('#score-state').dataset.state = data.status
  $('#score-updated').textContent = data.refreshedAt ? `北京时间 ${time(data.refreshedAt)} · 下次 ${time(data.nextRefreshAt)}` : (data.error ?? '尚无成功快照')
  renderScoreRows()
}

async function scoresPage() {
  $('#score-filter').addEventListener('input', renderScoreRows)
  $('#refresh-scores').addEventListener('click', async () => {
    const button = $('#refresh-scores')
    button.disabled = true
    $('#score-state').textContent = '刷新中'
    try { renderScores(await requestJson('/api/scores/refresh', { method: 'POST', body: '{}' }, 200000)) }
    catch (error) { $('#score-updated').textContent = error instanceof Error ? error.message : String(error) }
    finally { button.disabled = false }
  })
  renderScores(await requestJson('/api/scores'))
  setInterval(async () => {
    if (!document.hidden) renderScores(await requestJson('/api/scores').catch(() => ({ ok: false, accounts: scoreRows })))
  }, 30000)
}

async function rankingPage() {
  const data = await requestJson('/api/ranking')
  const ranking = data.ranking
  $('#ranking-range').textContent = `${ranking.startDate} 至 ${ranking.endDate}`
  $('#ranking-cost').textContent = `$${number(ranking.totals.actualCost, 3)}`
  $('#ranking-requests').textContent = compact(ranking.totals.requests)
  $('#ranking-tokens').textContent = compact(ranking.totals.tokens)
  $('#ranking-body').innerHTML = ranking.rows.length ? ranking.rows.map((row) => `<tr><td>${String(row.rank).padStart(2, '0')}</td><td class="account-cell"><b>${escapeHtml(row.displayName)}</b></td><td>$${number(row.actualCost, 3)}</td><td>${compact(row.requests)}</td><td>${compact(row.tokens)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">当前窗口暂无用量</td></tr>'
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

async function boot() {
  if (page === 'login') return await loginPage()
  shell()
  if (page === 'scores') return await scoresPage()
  if (page === 'ranking') return await rankingPage()
  if (page === 'lottery') return await lotteryPage()
}

boot().catch((error) => {
  const target = $('.workspace') ?? $('main')
  if (target) target.insertAdjacentHTML('afterbegin', `<div class="fatal-state">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`)
})
