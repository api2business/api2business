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
    $('#bugteam-unit-price').textContent = latest.unitPriceCny === null ? '—' : `¥${number(latest.unitPriceCny, 2)}`
    $('#bugteam-cost-range').textContent = latest.minimumExpectedCostCnyPerApiUsd === null
      ? '—'
      : `¥${number(latest.minimumExpectedCostCnyPerApiUsd, 4)}–${number(latest.maximumExpectedCostCnyPerApiUsd, 4)}`
    $('#bugteam-fill-rate').textContent = latest.fillRateApiUsdPerHour === null ? '—' : number(latest.fillRateApiUsdPerHour, 2)
    $('#bugteam-remaining').textContent = durationRange(latest.minimumRemainingSeconds, latest.maximumRemainingSeconds)
    $('#bugteam-sampled-at').textContent = `采样时间 ${time(latest.sampledAt)}`
  }

  const points = data.history ?? []
  drawChart('#bugteam-available-chart', points, {
    series: [{ key: 'available', className: 'chart-bugteam-stock', label: '未售' }],
    valueFormatter: (value) => number(value, 0), unit: '个', ariaLabel: 'BugTeam 剩余未售趋势',
  })
  drawChart('#bugteam-price-chart', points, {
    series: [
      { key: 'unitPriceCny', className: 'chart-bugteam-price', label: '当前单价' },
      { key: 'minimumUnitPriceCny', className: 'chart-bugteam-price-min', label: '最低单价' },
      { key: 'maximumUnitPriceCny', className: 'chart-bugteam-price-max', label: '最高单价' },
    ],
    valueFormatter: (value) => number(value, 2), unit: '人民币/个', ariaLabel: 'BugTeam 浮动单价趋势',
  })
  drawChart('#bugteam-cost-chart', points, {
    series: [
      { key: 'minimumExpectedCostCnyPerApiUsd', className: 'chart-bugteam-cost-min', label: '成本下界' },
      { key: 'maximumExpectedCostCnyPerApiUsd', className: 'chart-bugteam-cost-max', label: '成本上界' },
    ],
    valueFormatter: (value) => number(value, 4), unit: '人民币/API美元', ariaLabel: 'BugTeam 单号预期成本范围趋势',
  })
  drawChart('#bugteam-speed-chart', points, {
    series: [{ key: 'fillRateApiUsdPerHour', className: 'chart-bugteam-speed', label: '吃满速度' }],
    valueFormatter: (value) => number(value, 2), unit: 'API美元/小时', ariaLabel: 'BugTeam 单号吃满速度趋势',
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
