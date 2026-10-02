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

export function historyChartMarkup(points, { series, valueFormatter, unit = '', ariaLabel = '历史趋势', yMin = null, yMax = null, missingKey = null, plotLeft: requestedPlotLeft = 64, plotRight: requestedPlotRight = 986, chartWidth = 1000, chartHeight = 180 }) {
  if (points.length < 2) return `<text x="${chartWidth / 2}" y="78" text-anchor="middle" class="chart-empty">至少需要两个采样点</text>`
  const chartPoints = points
  const values = series.flatMap(({ key }) => chartPoints
    .filter((point) => point[key] !== null && point[key] !== undefined)
    .map((point) => Number(point[key])).filter(Number.isFinite))
  if (values.length < 2) return `<text x="${chartWidth / 2}" y="78" text-anchor="middle" class="chart-empty">当前指标暂无有效曲线</text>`
  const rawMin = Math.min(...values), rawMax = Math.max(...values)
  const configuredMin = Number(yMin), configuredMax = Number(yMax)
  const lowerBound = yMin !== null && Number.isFinite(configuredMin) ? configuredMin : null
  const upperBound = yMax !== null && Number.isFinite(configuredMax) ? configuredMax : null
  const padding = Math.max((rawMax - rawMin) * 0.08, Math.abs(rawMax) * 0.02, 0.001)
  const min = lowerBound ?? Math.max(0, rawMin - padding)
  const max = upperBound ?? rawMax + padding
  const span = Math.max(max - min, 0.001)
  const requestedLeft = Number(requestedPlotLeft), requestedRight = Number(requestedPlotRight)
  const plotLeft = Math.max(0, Number.isFinite(requestedLeft) ? requestedLeft : 64), plotRight = Math.min(chartWidth - 2, Math.max(plotLeft + 100, Number.isFinite(requestedRight) ? requestedRight : 986))
  // 坐标区随画框缩放，保留最小文字安全边距，桌面和移动端使用同一比例。
  const plotTop = Math.max(24, Math.round(chartHeight * 0.08)), plotBottom = chartHeight - Math.max(16, Math.round(chartHeight * 0.05))
  const x = (index) => plotLeft + index * (plotRight - plotLeft) / Math.max(1, chartPoints.length - 1)
  const y = (value) => plotBottom - (Math.min(max, Math.max(min, value)) - min) / span * (plotBottom - plotTop)
  const formatValue = typeof valueFormatter === 'function' ? valueFormatter : (value) => number(value, 2)
  const ticks = [max, (max + min) / 2, min]
  const grid = ticks.map((value) => {
    const row = y(value)
    const axisInside = plotLeft < 36
    return `<text x="${axisInside ? 8 : Math.max(4, plotLeft - 4)}" y="${row + 3}" text-anchor="${axisInside ? 'start' : 'end'}" class="chart-axis chart-axis-y">${escapeHtml(formatValue(value))}</text><line x1="${plotLeft}" y1="${row}" x2="${plotRight}" y2="${row}" class="chart-grid"/>`
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
    const polylines = missingKey === null
      ? segments.map((values) => `<polyline class="${className}" points="${values.map(({ index, value }) => `${x(index)},${y(value)}`).join(' ')}"/>`).join('')
      : valuesByPoint.slice(1).map((value, index) => {
          const previous = valuesByPoint[index]
          if (previous === null || value === null) return ''
          const missing = Boolean(chartPoints[index]?.[missingKey] || chartPoints[index + 1]?.[missingKey])
          return `<line class="${className} chart-series-segment${missing ? ' chart-missing-segment' : ''}" x1="${x(previous.index)}" y1="${y(previous.value)}" x2="${x(value.index)}" y2="${y(value.value)}"/>`
        }).join('')
    const currentMissing = current && missingKey !== null && Boolean(chartPoints[current.index]?.[missingKey])
    const currentPoint = current === null || current === undefined ? '' : `<circle class="${className} chart-latest-point${currentMissing ? ' chart-missing-point' : ''}" cx="${x(current.index)}" cy="${y(current.value)}" r="3"><title>${escapeHtml(label ?? key)}：${escapeHtml(formatValue(current.value))}${unit ? ` ${escapeHtml(unit)}` : ''}${currentMissing ? '（缺数据，沿用最近值）' : ''}</title></circle>`
    return `${polylines}${currentPoint}${clippedHigh}${clippedLow}`
  }).join('')
  const first = new Date(chartPoints[0].sampledAt), last = new Date(chartPoints.at(-1).sampledAt)
  const label = (date) => date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
  const hasMissing = missingKey !== null && chartPoints.some((point) => Boolean(point[missingKey]))
  const legend = `${series.map(({ className, label: seriesLabel }) => `<span class="history-chart-legend-item ${className}">${escapeHtml(seriesLabel ?? '')}</span>`).join('')}${hasMissing ? '<span class="history-chart-legend-item chart-missing-legend">缺数据沿用</span>' : ''}`
  const hoverWidth = (plotRight - plotLeft) / Math.max(1, chartPoints.length - 1)
  const hoverTargets = chartPoints.map((point, index) => {
    const at = new Date(point.sampledAt)
    const details = series.map(({ key, label: seriesLabel }) => {
      const value = Number(point[key])
      return `${seriesLabel ?? key}：${point[key] == null || !Number.isFinite(value) ? '无数据' : `${formatValue(value)}${unit ? ` ${unit}` : ''}`}`
    }).join('\n') + (missingKey !== null && point[missingKey] ? '\n缺数据，沿用最近值' : '')
    const left = Math.max(plotLeft, x(index) - hoverWidth / 2)
    const right = Math.min(plotRight, x(index) + hoverWidth / 2)
    return `<g class="chart-hover-column" data-tooltip="${escapeHtml(`${label(at)}\n${details}`)}"><line x1="${x(index)}" y1="${plotTop}" x2="${x(index)}" y2="${plotBottom}"/><rect x="${left}" y="${plotTop}" width="${Math.max(8, right - left)}" height="${plotBottom - plotTop}"/></g>`
  }).join('')
  const capLabels = `${upperBound === null ? '' : `<text x="${plotRight}" y="${plotTop + 10}" text-anchor="end" class="chart-cap-label">展示上限 ${escapeHtml(formatValue(upperBound))}</text>`}${lowerBound === null ? '' : `<text x="${plotRight}" y="${plotBottom - 5}" text-anchor="end" class="chart-cap-label">展示下限 ${escapeHtml(formatValue(lowerBound))}</text>`}`
  return `<title>${escapeHtml(ariaLabel)}</title>${grid}${lines}${hoverTargets}${capLabels}<text x="${plotLeft}" y="${chartHeight - 4}" class="chart-axis">${label(first)}</text><text x="${plotRight}" y="${chartHeight - 4}" text-anchor="end" class="chart-axis">${label(last)}</text><foreignObject x="${plotLeft}" y="1" width="${plotRight - plotLeft}" height="${chartHeight === 180 ? 16 : 36}"><div xmlns="http://www.w3.org/1999/xhtml" class="history-chart-meta"><span>${escapeHtml(unit)}</span><span class="history-chart-legend">${legend}</span></div></foreignObject>`
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
