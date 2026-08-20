import { bindHistoryChartTooltip, historyChartMarkup } from './history-chart.js'

const $ = (selector) => document.querySelector(selector)
let selectedHours = 6
let refreshTimer = null
let purchaseOptions = null
let currentAvailable = 0
let currentUnitPrice = null
let purchaseRunning = false
let sampleRunning = false

function number(value, digits = 2) {
  const numeric = Number(value)
  if (value === null || value === undefined || !Number.isFinite(numeric)) return '—'
  return numeric.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function time(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value))
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

async function requestJson(path, init = {}, timeout = 20000) {
  const response = await fetch(path, { ...init, headers: { accept: 'application/json', 'content-type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeout) })
  const data = await response.json().catch(() => null)
  if (response.status === 401) {
    location.assign('/login')
    throw new Error('登录状态已失效')
  }
  if (!response.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
  return data
}

function durationRange(minimum, maximum) {
  if (!Number.isFinite(Number(minimum)) || !Number.isFinite(Number(maximum))) return '—'
  const format = (seconds) => {
    const minutes = Math.max(0, Number(seconds)) / 60
    return minutes >= 60 ? `${number(minutes / 60, 1)}h` : `${number(minutes, 0)}m`
  }
  return Number(minimum) === Number(maximum) ? format(minimum) : `${format(minimum)}–${format(maximum)}`
}

const carriedMetricKeys = [
  'unitPriceCny', 'minimumUnitPriceCny', 'maximumUnitPriceCny',
  'minimumRemainingSeconds', 'maximumRemainingSeconds',
  'expectedCostCnyPerApiUsd', 'minimumExpectedCostCnyPerApiUsd',
  'maximumExpectedCostCnyPerApiUsd', 'fillRateApiUsdPerHour',
]

function carryForwardEmptySamples(points) {
  let lastValid = null
  return points.map((point) => {
    if (point.status === 'ok') {
      lastValid = Object.fromEntries(carriedMetricKeys.map((key) => [key, point[key]]))
      return { ...point, chartMissing: false }
    }
    if (point.status !== 'empty') return { ...point, chartMissing: false }
    return lastValid === null
      ? { ...point, chartMissing: carriedMetricKeys.some((key) => point[key] !== null && point[key] !== undefined) }
      : { ...point, ...lastValid, chartMissing: true }
  })
}

async function requestSummary() {
  return await requestJson(`/api/bugteam/cost-monitor?hours=${selectedHours}`)
}

async function waitSampleJob(workflowId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await requestJson(`/api/bugteam/cost-monitor/jobs/${encodeURIComponent(workflowId)}`)
    if (status.terminal) {
      if (status.state !== 'completed') throw new Error(status.error ?? `采样作业${status.state ?? '失败'}`)
      if (status.result?.ok === false) throw new Error(status.result?.error ?? '采样作业未成功完成')
      return status.result
    }
    if (Date.now() >= deadline) throw new Error('采样作业等待超时，请稍后刷新查看结果')
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

async function sampleNow() {
  if (sampleRunning) return
  const button = $('#bugteam-sample-now')
  sampleRunning = true
  button.disabled = true
  button.classList.add('is-loading')
  $('#bugteam-sample-state').textContent = '正在执行立即采样'
  try {
    const submitted = await requestJson('/api/bugteam/cost-monitor/sample', { method: 'POST' })
    await waitSampleJob(submitted.workflowId)
    sampleRunning = false
    await load()
  } catch (error) {
    sampleRunning = false
    $('#bugteam-sample-state').textContent = error instanceof Error ? error.message : String(error)
  } finally {
    button.disabled = false
    button.classList.remove('is-loading')
  }
}

function updatePurchaseQuote() {
  const quantity = Math.max(1, Number($('#bugteam-purchase-quantity')?.value ?? 1))
  $('#bugteam-purchase-quote').textContent = currentUnitPrice === null ? '—' : `¥${number(currentUnitPrice * quantity, 2)}`
  $('#bugteam-purchase-stock').textContent = currentAvailable > 0 ? `${currentAvailable} 个可售 · 下单时刷新报价` : '当前无库存'
  $('#bugteam-purchase-quantity').max = Math.max(1, currentAvailable)
  $('#bugteam-purchase-submit').disabled = purchaseRunning || currentAvailable < quantity
}

function drawChart(selector, points, options) {
  const svg = $(selector)
  svg.innerHTML = historyChartMarkup(points, options)
  bindHistoryChartTooltip(svg)
}

function render(data) {
  const latest = data.latest
  const points = data.history ?? []
  const chartPoints = carryForwardEmptySamples(points)
  const displayLatest = latest?.status === 'empty'
    ? chartPoints.findLast((point) => String(point.sampledAt) === String(latest.sampledAt)) ?? latest
    : latest
  const state = $('#bugteam-state')
  const windowText = `最近 ${selectedHours} 小时`
  for (const selector of ['#bugteam-available-window', '#bugteam-price-window', '#bugteam-speed-window']) $(selector).textContent = windowText
  $('#bugteam-cost-window').textContent = `${number(data.expectedOutputApiUsd, 0)} API 美元预期产出`

  if (!latest) {
    currentAvailable = 0
    currentUnitPrice = null
    state.dataset.state = data.lastError ? 'unavailable' : 'stale'
    state.textContent = data.lastError ? '采样失败' : '等待样本'
    $('#bugteam-sample-state').textContent = data.lastError?.message ?? '尚无成功采样'
  } else {
    const empty = latest.status === 'empty'
    state.dataset.state = data.lastError ? 'stale' : 'ready'
    state.textContent = data.lastError ? '沿用最近样本' : (empty ? '库存为空' : '实时')
    $('#bugteam-sample-state').textContent = data.lastError
      ? `最近采样失败：${data.lastError.message}`
      : `每 ${data.sampling.intervalSeconds} 秒采样 · ${data.product}`
    $('#bugteam-available').textContent = latest.available ?? '—'
    $('#bugteam-unit-price').textContent = displayLatest.unitPriceCny === null ? '—' : `¥${number(displayLatest.unitPriceCny, 2)}`
    $('#bugteam-cost-range').textContent = displayLatest.expectedCostCnyPerApiUsd === null
      ? '—'
      : `¥${number(displayLatest.expectedCostCnyPerApiUsd, 4)}`
    $('#bugteam-fill-rate').textContent = displayLatest.fillRateApiUsdPerHour === null ? '—' : number(displayLatest.fillRateApiUsdPerHour, 2)
    $('#bugteam-remaining').textContent = durationRange(displayLatest.minimumRemainingSeconds, displayLatest.maximumRemainingSeconds)
    $('#bugteam-sampled-at').textContent = `采样时间 ${time(latest.sampledAt)}`
    currentAvailable = Number(latest.available) || 0
    currentUnitPrice = displayLatest.unitPriceCny === null ? null : Number(displayLatest.unitPriceCny)
  }
  updatePurchaseQuote()

  drawChart('#bugteam-available-chart', chartPoints, {
    series: [{ key: 'available', className: 'chart-bugteam-stock', label: '未售' }],
    valueFormatter: (value) => number(value, 0), unit: '个', ariaLabel: 'BugTeam 剩余未售趋势', missingKey: 'chartMissing',
  })
  drawChart('#bugteam-price-chart', chartPoints, {
    series: [{ key: 'unitPriceCny', className: 'chart-bugteam-price', label: '最低价车次' }],
    valueFormatter: (value) => number(value, 2), unit: '人民币/个', ariaLabel: 'BugTeam 最低价车次浮动单价趋势', missingKey: 'chartMissing',
  })
  drawChart('#bugteam-cost-chart', chartPoints, {
    series: [{ key: 'expectedCostCnyPerApiUsd', className: 'chart-bugteam-price', label: '预期成本' }],
    valueFormatter: (value) => number(value, 4), unit: '人民币/API美元', ariaLabel: 'BugTeam 最低价车次单号预期成本趋势', missingKey: 'chartMissing',
  })
  drawChart('#bugteam-speed-chart', chartPoints, {
    series: [{ key: 'fillRateApiUsdPerHour', className: 'chart-bugteam-speed', label: '吃满速度' }],
    valueFormatter: (value) => number(value, 2), unit: 'API美元/小时', ariaLabel: 'BugTeam 单号吃满速度趋势', missingKey: 'chartMissing',
  })
}

async function loadPurchaseOptions() {
  const options = await requestJson('/api/bugteam/purchase/options')
  purchaseOptions = options
  $('#bugteam-purchase-priority').value = options.defaults.priority
  $('#bugteam-purchase-capacity').value = options.defaults.capacity
  $('#bugteam-purchase-rate-multiplier').value = options.defaults.rateMultiplier
  $('#bugteam-purchase-groups').innerHTML = options.groups.map((group) => `<label><input type="checkbox" value="${group.id}" ${options.defaults.groupIds.includes(group.id) ? 'checked' : ''}/><span>${escapeHtml(group.name)} <b>#${group.id}</b></span></label>`).join('')
  updatePurchaseQuote()
}

function renderPurchaseJob(job) {
  const badge = $('#bugteam-purchase-state')
  badge.textContent = ({ queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败' })[job.state] ?? job.state
  badge.dataset.state = job.state === 'succeeded' ? 'ready' : job.state === 'failed' ? 'unavailable' : 'refreshing'
  $('#bugteam-purchase-job-id').textContent = `JOB ${job.id}`
  const groups = (purchaseOptions?.groups ?? []).filter((group) => job.settings.groupIds.includes(group.id)).map((group) => `${group.name} #${group.id}`).join('、')
  const quote = job.quote ? ` · 报价 ¥${number(job.quote.estimatedUnitPriceCny, 2)} / 个` : ''
  const order = job.order ? ` · 订单 ${job.order.id} · ${job.order.state}` : ''
  const actual = job.order?.unitCostCny != null ? ` · 成交单价 ¥${number(job.order.unitCostCny, 2)}` : ''
  const imported = job.importJob ? ` · 导入 ${job.importJob.state}` : ''
  $('#bugteam-purchase-summary').textContent = `TEAM 1H · ${job.settings.quantity} 个 · 优先级 ${job.settings.priority} · 容量 ${job.settings.capacity} · 负载因子 ${job.settings.rateMultiplier} · ${groups}${quote}${order}${actual}${imported}${job.error ? ` · ${job.error}` : ''}`
  $('#bugteam-purchase-logs').innerHTML = job.logs.length ? job.logs.map((log) => `<li data-state="${escapeHtml(log.state)}"><time>${time(log.timestamp)}</time><b>${escapeHtml(log.stage)}</b><span>${escapeHtml(log.message)}</span></li>`).join('') : '<li class="empty">等待作业启动</li>'
  $('#bugteam-purchase-logs').scrollTop = $('#bugteam-purchase-logs').scrollHeight
}

async function submitPurchase(event) {
  event.preventDefault()
  if (purchaseRunning || !purchaseOptions) return
  purchaseRunning = true
  updatePurchaseQuote()
  try {
    const groupIds = [...document.querySelectorAll('#bugteam-purchase-groups input:checked')].map((input) => Number(input.value))
    const rateMultiplier = Number($('#bugteam-purchase-rate-multiplier').value)
    if (!Number.isInteger(rateMultiplier) || rateMultiplier < 1 || rateMultiplier > 1000000) throw new Error('负载因子必须为 1 至 1000000 的整数')
    const response = await requestJson('/api/bugteam/purchase/jobs', { method: 'POST', body: JSON.stringify({
      quantity: Number($('#bugteam-purchase-quantity').value),
      priority: Number($('#bugteam-purchase-priority').value),
      capacity: Number($('#bugteam-purchase-capacity').value),
      rateMultiplier,
      groupIds,
      sourceProxyId: purchaseOptions.defaults.sourceProxyId,
      perAccountProxy: purchaseOptions.defaults.perAccountProxy,
    }) }, 30000)
    let job = response.job
    renderPurchaseJob(job)
    while (job.state === 'queued' || job.state === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      job = (await requestJson(`/api/bugteam/purchase/jobs/${encodeURIComponent(job.id)}`)).job
      renderPurchaseJob(job)
    }
  } catch (error) {
    $('#bugteam-purchase-state').dataset.state = 'unavailable'
    $('#bugteam-purchase-state').textContent = '失败'
    $('#bugteam-purchase-summary').textContent = error instanceof Error ? error.message : String(error)
  } finally {
    purchaseRunning = false
    updatePurchaseQuote()
  }
}

async function load() {
  const button = $('#bugteam-refresh')
  button.classList.add('is-loading')
  try {
    render(await requestSummary())
  } catch (error) {
    $('#bugteam-state').dataset.state = 'unavailable'
    $('#bugteam-state').textContent = '不可用'
    $('#bugteam-sample-state').textContent = error instanceof Error ? error.message : String(error)
  } finally {
    button.classList.remove('is-loading')
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(load, 60000)
  }
}

document.querySelectorAll('[data-history-hours]').forEach((button) => button.addEventListener('click', () => {
  selectedHours = Number(button.dataset.historyHours)
  document.querySelectorAll('[data-history-hours]').forEach((item) => item.classList.toggle('is-active', item === button))
  void load()
}))
$('#bugteam-refresh').addEventListener('click', () => void load())
$('#bugteam-sample-now').addEventListener('click', () => void sampleNow())
$('#bugteam-purchase-quantity').addEventListener('input', updatePurchaseQuote)
$('#bugteam-purchase-form').addEventListener('submit', (event) => void submitPurchase(event))
void Promise.all([loadPurchaseOptions(), load()])
