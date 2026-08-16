import { bindHistoryChartTooltip, historyChartMarkup } from './history-chart.js'

const $ = (selector) => document.querySelector(selector)
let selectedHours = 6
let refreshTimer = null

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
  const response = await fetch(`/api/bugteam/cost-monitor?hours=${selectedHours}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  })
  const data = await response.json().catch(() => null)
  if (response.status === 401) {
    location.assign('/login')
    throw new Error('登录状态已失效')
  }
  if (!response.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
  return data
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
  }

  drawChart('#bugteam-available-chart', points, {
    series: [{ key: 'available', className: 'chart-bugteam-stock', label: '未售' }],
    valueFormatter: (value) => number(value, 0), unit: '个', ariaLabel: 'BugTeam 剩余未售趋势',
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
void load()
