const $ = (selector) => document.querySelector(selector)
const fields = (name) => document.querySelectorAll(`[data-field="${name}"]`)
const setField = (name, value) => fields(name).forEach((node) => { node.textContent = String(value) })

const button = $('#draw-button')
const stage = $('.draw-stage')
const statusLine = $('#draw-status')
const rankingBody = $('#ranking-body')
const recordList = $('#record-list')
const creditMode = $('#credit-mode')
const dialog = $('#winner-dialog')

let state = null
let drawing = false

function money(value, digits = 2) {
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function compact(value) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value))
}

function localTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

function renderRanking(ranking) {
  const rows = ranking?.rows ?? []
  if (!rows.length) {
    rankingBody.innerHTML = '<tr><td colspan="4" class="empty">当前窗口暂无用量</td></tr>'
    return
  }
  rankingBody.innerHTML = rows.map((row) => `<tr>
    <td>${String(row.rank).padStart(2, '0')}</td>
    <td><b>${escapeHtml(row.displayName)}</b></td>
    <td>$${money(row.actualCost, 3)}</td>
    <td>${compact(row.requests)} 次<span class="usage-detail">${compact(row.tokens)} tokens</span></td>
  </tr>`).join('')
}

function renderRecords(records) {
  if (!records?.length) {
    recordList.innerHTML = '<li class="empty">第一位幸运用户，会是谁？</li>'
    return
  }
  recordList.innerHTML = records.map((record, index) => `<li>
    <span class="record-badge">#${String(index + 1).padStart(2, '0')}</span>
    <span class="record-main"><b>${escapeHtml(record.winnerDisplayName)}</b><small>${localTime(record.drawnAt)} · ${record.eligibleCount} 人等概率</small></span>
    <span class="record-prize">$${money(record.prizeAmountUsd, 0)}<small>${creditLabel(record.creditStatus)}</small></span>
  </li>`).join('')
}

function creditLabel(status) {
  return ({ succeeded: '已充值', dry_run: '模拟充值', disabled: '充值未开启', pending: '充值待确认', failed: '充值失败' })[status] ?? status
}

function escapeHtml(value) {
  const node = document.createElement('span')
  node.textContent = String(value)
  return node.innerHTML
}

function render(next) {
  state = next
  setField('active-hours', next.activeWithinHours)
  setField('prize', money(next.prizeAmountUsd, 0))
  setField('remaining', next.remainingDraws)
  setField('eligible', next.eligibleUserCount ?? '—')
  setField('daily-grant', next.dailyGrantCount)
  setField('next-grant', localTime(next.nextGrantAt))
  setField('ranking-label', next.rankingWindowDays === 1 ? '今日' : `近 ${next.rankingWindowDays} 日`)
  setField('ranking-total', `$${money(next.ranking?.totals?.actualCost ?? 0)}`)
  renderRanking(next.ranking)
  renderRecords(next.records)
  const autoEnabled = next.automaticCredit?.enabled === true
  creditMode.textContent = autoEnabled ? (next.automaticCredit.mode === 'live' ? '自动充值已开启' : '自动充值模拟中') : '自动充值暂未开启'
  button.disabled = drawing || Number(next.remainingDraws) < 1 || Number(next.eligibleUserCount) < 1
  statusLine.textContent = Number(next.remainingDraws) < 1 ? '今天的机会已用完，明早 06:00 再来' : `${next.eligibleUserCount} 名候选人已就位`
}

async function requestJson(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const raw = await response.text()
    let data = null
    try { data = raw ? JSON.parse(raw) : null } catch { /* handled below */ }
    if (!response.ok || !data?.ok) throw new Error(data?.error ?? `服务暂不可用（HTTP ${response.status}）`)
    return data
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('请求超时，请稍后重试')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function loadState() {
  const data = await requestJson('/api/public/state', { cache: 'no-store' })
  render(data)
}

function showStateError(error) {
  const message = error instanceof Error ? error.message : String(error)
  statusLine.textContent = `${message}，正在重试…`
  rankingBody.innerHTML = '<tr><td colspan="4" class="empty">服务暂时不可用，正在重试…</td></tr>'
  creditMode.textContent = '连接中断'
  button.disabled = true
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function draw() {
  if (drawing) return
  drawing = true
  button.disabled = true
  stage.classList.add('is-drawing')
  const phrases = ['锁定活跃用户…', '打乱候选顺序…', '正在碰撞好运…', '马上揭晓！']
  let phraseIndex = 0
  const ticker = setInterval(() => {
    statusLine.textContent = phrases[phraseIndex % phrases.length]
    phraseIndex += 1
  }, 620)
  try {
    const request = requestJson('/api/public/draw', { method: 'POST', headers: { 'content-type': 'application/json' } })
    const [, data] = await Promise.all([sleep(2900), request])
    $('#winner-name').textContent = data.record.winnerDisplayName
    $('#winner-prize').textContent = money(data.record.prizeAmountUsd, 0)
    $('#winner-meta').textContent = `${data.record.eligibleCount} 人等概率 · ${creditLabel(data.record.creditStatus)}`
    dialog.showModal()
    await loadState()
  } catch (error) {
    statusLine.textContent = error instanceof Error ? error.message : String(error)
    await loadState().catch((stateError) => {
      state = null
      showStateError(stateError)
      setTimeout(boot, 5000)
    })
  } finally {
    clearInterval(ticker)
    drawing = false
    stage.classList.remove('is-drawing')
    button.disabled = !state || Number(state.remainingDraws) < 1 || Number(state.eligibleUserCount) < 1
  }
}

button.addEventListener('click', draw)
$('#winner-close').addEventListener('click', () => dialog.close())
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close() })

async function boot() {
  try { await loadState() } catch (error) {
    showStateError(error)
    setTimeout(boot, 5000)
  }
}

boot()

setInterval(() => {
  if (!drawing && !document.hidden) loadState().catch(showStateError)
}, 30000)
