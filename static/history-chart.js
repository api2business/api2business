function escapeHtml(value) {
  const node = document.createElement('span')
  node.textContent = String(value ?? '')
  return node.innerHTML
}

function number(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

export function finiteChartValue(value) {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function historyChartMarkup(points, { series, valueFormatter, unit = '', ariaLabel = '历史趋势', yMin = null, yMax = null }) {
  const chartWidth = 1000
  if (points.length < 2) return `<text x="${chartWidth / 2}" y="78" text-anchor="middle" class="chart-empty">至少需要两个采样点</text>`
  const chartPoints = points
  const values = series.flatMap(({ key }) => chartPoints
    .filter((point) => point[key] !== null && point[key] !== undefined)
    .map((point) => Number(point[key])).filter(Number.isFinite))
  if (values.length < 2) return `<text x="${chartWidth / 2}" y="78" text-anchor="middle" class="chart-empty">当前指标暂无有效曲线</text>`
  const rawMin = Math.min(...values), rawMax = Math.max(...values)
  const configuredMin = Number(yMin), configuredMax = Number(yMax)
  const lowerBound = yMin !== null && Number.isFinite(configuredMin) && rawMin <= configuredMin ? configuredMin : null
  const upperBound = yMax !== null && Number.isFinite(configuredMax) && rawMax >= configuredMax ? configuredMax : null
  const padding = Math.max((rawMax - rawMin) * 0.08, Math.abs(rawMax) * 0.02, 0.001)
  const min = lowerBound ?? Math.max(0, rawMin - padding)
  const max = upperBound ?? rawMax + padding
  const span = Math.max(max - min, 0.001)
  const plotLeft = 64, plotRight = chartWidth - 14, plotTop = 18, plotBottom = 126
  const x = (index) => plotLeft + index * (plotRight - plotLeft) / Math.max(1, chartPoints.length - 1)
  const y = (value) => plotBottom - (Math.min(max, Math.max(min, value)) - min) / span * (plotBottom - plotTop)
  const formatValue = typeof valueFormatter === 'function' ? valueFormatter : (value) => number(value, 2)
  const ticks = [max, (max + min) / 2, min]
  const grid = ticks.map((value) => {
    const row = y(value)
    return `<text x="56" y="${row + 3}" text-anchor="end" class="chart-axis chart-axis-y">${escapeHtml(formatValue(value))}</text><line x1="${plotLeft}" y1="${row}" x2="${plotRight}" y2="${row}" class="chart-grid"/>`
  }).join('')
  const lines = series.map(({ key, className, label }) => {
    const valuesByPoint = chartPoints.map((point, index) => {
      const value = finiteChartValue(point[key])
      return value === null ? null : { index, value }
    })
    const valid = valuesByPoint.filter((value) => value !== null)
    if (valid.length < 2) return ''
    const segments = []
    let segment = []
    for (const value of valuesByPoint) {
      if (value === null) {
        if (segment.length > 1) segments.push(segment)
        segment = []
      } else segment.push(value)
    }
    if (segment.length > 1) segments.push(segment)
    const current = valuesByPoint.at(-1)
    const clippedHigh = upperBound === null ? '' : valid.filter(({ value }) => value > upperBound).map(({ index, value }) => `<path class="${className} chart-clipped-point" d="M ${x(index) - 4} ${plotTop + 7} L ${x(index)} ${plotTop + 1} L ${x(index) + 4} ${plotTop + 7} Z"><title>${escapeHtml(label ?? key)}：${escapeHtml(formatValue(value))}${unit ? ` ${escapeHtml(unit)}` : ''}（超出图表上限 ${escapeHtml(formatValue(upperBound))}）</title></path>`).join('')
    const clippedLow = lowerBound === null ? '' : valid.filter(({ value }) => value < lowerBound).map(({ index, value }) => `<path class="${className} chart-clipped-point" d="M ${x(index) - 4} ${plotBottom - 7} L ${x(index)} ${plotBottom - 1} L ${x(index) + 4} ${plotBottom - 7} Z"><title>${escapeHtml(label ?? key)}：${escapeHtml(formatValue(value))}${unit ? ` ${escapeHtml(unit)}` : ''}（低于图表下限 ${escapeHtml(formatValue(lowerBound))}）</title></path>`).join('')
    const polylines = segments.map((values) => `<polyline class="${className}" points="${values.map(({ index, value }) => `${x(index)},${y(value)}`).join(' ')}"/>`).join('')
    const currentPoint = current === null || current === undefined ? '' : `<circle class="${className} chart-latest-point" cx="${x(current.index)}" cy="${y(current.value)}" r="3"><title>${escapeHtml(label ?? key)}：${escapeHtml(formatValue(current.value))}${unit ? ` ${escapeHtml(unit)}` : ''}</title></circle>`
    return `${polylines}${currentPoint}${clippedHigh}${clippedLow}`
  }).join('')
  const first = new Date(chartPoints[0].sampledAt), last = new Date(chartPoints.at(-1).sampledAt)
  const label = (date) => date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
  const legend = series.map(({ className, label: seriesLabel }) => `<span class="history-chart-legend-item ${className}">${escapeHtml(seriesLabel ?? '')}</span>`).join('')
  const hoverWidth = (plotRight - plotLeft) / Math.max(1, chartPoints.length - 1)
  const hoverTargets = chartPoints.map((point, index) => {
    const at = new Date(point.sampledAt)
    const details = series.map(({ key, label: seriesLabel }) => {
      const value = Number(point[key])
      return `${seriesLabel ?? key}：${point[key] == null || !Number.isFinite(value) ? '无数据' : `${formatValue(value)}${unit ? ` ${unit}` : ''}`}`
    }).join('\n')
    const left = Math.max(plotLeft, x(index) - hoverWidth / 2)
    const right = Math.min(plotRight, x(index) + hoverWidth / 2)
    return `<g class="chart-hover-column" data-tooltip="${escapeHtml(`${label(at)}\n${details}`)}"><line x1="${x(index)}" y1="${plotTop}" x2="${x(index)}" y2="${plotBottom}"/><rect x="${left}" y="${plotTop}" width="${Math.max(8, right - left)}" height="${plotBottom - plotTop}"/></g>`
  }).join('')
  const capLabels = `${upperBound === null ? '' : `<text x="${plotRight}" y="${plotTop + 10}" text-anchor="end" class="chart-cap-label">展示上限 ${escapeHtml(formatValue(upperBound))}</text>`}${lowerBound === null ? '' : `<text x="${plotRight}" y="${plotBottom - 5}" text-anchor="end" class="chart-cap-label">展示下限 ${escapeHtml(formatValue(lowerBound))}</text>`}`
  return `<title>${escapeHtml(ariaLabel)}</title>${grid}${lines}${hoverTargets}${capLabels}<text x="${plotLeft}" y="147" class="chart-axis">${label(first)}</text><text x="${plotRight}" y="147" text-anchor="end" class="chart-axis">${label(last)}</text><foreignObject x="${plotLeft}" y="1" width="${plotRight - plotLeft}" height="16"><div xmlns="http://www.w3.org/1999/xhtml" class="history-chart-meta"><span>${escapeHtml(unit)}</span><span class="history-chart-legend">${legend}</span></div></foreignObject>`
}

export function bindHistoryChartTooltip(svg) {
  if (!svg) return
  const host = svg.parentElement
  if (!host) return
  let tooltip = host.querySelector('.history-chart-tooltip')
  if (!tooltip) {
    tooltip = document.createElement('div')
    tooltip.className = 'history-chart-tooltip'
    host.append(tooltip)
  }
  tooltip.style.display = 'none'
  svg.querySelectorAll('.chart-hover-column').forEach((column) => {
    const position = (event) => {
      const hostBounds = host.getBoundingClientRect()
      const bounds = tooltip.getBoundingClientRect()
      tooltip.style.left = `${Math.max(8, Math.min(event.clientX - hostBounds.left + 12, hostBounds.width - bounds.width - 8))}px`
      tooltip.style.top = `${Math.max(8, Math.min(event.clientY - hostBounds.top + 12, hostBounds.height - bounds.height - 8))}px`
    }
    column.addEventListener('pointerenter', (event) => {
      tooltip.textContent = column.dataset.tooltip ?? ''
      tooltip.style.display = 'block'
      position(event)
    })
    column.addEventListener('pointermove', (event) => {
      if (tooltip.style.display === 'block') position(event)
    })
    column.addEventListener('pointerleave', () => { tooltip.style.display = 'none' })
  })
}
