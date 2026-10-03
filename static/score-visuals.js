export const poolParticipationColors = ['#afdd4a', '#78b8de', '#d6a94d', '#d77b70', '#9ba7d7', '#74c7a1', '#d49ad2', '#b6a37c']

export function renderDonut({ ring, detail, items, center, centerLabel, emptyDetail, itemLabel, itemDetail, itemColor }) {
  const normalized = items.filter((item) => Number(item.ratio) > 0)
  let angle = 0
  const stops = normalized.map((item, index) => {
    const start = angle
    angle += Number(item.ratio) * 360
    const color = itemColor?.(item, index) ?? poolParticipationColors[index % poolParticipationColors.length]
    return `${color} ${start}deg ${angle}deg`
  })
  ring.style.background = stops.length ? `radial-gradient(circle, var(--surface) 0 56%, transparent 57%), conic-gradient(${stops.join(',')})` : ''
  ring.innerHTML = `<strong>${center}</strong><small>${centerLabel}</small>`
  detail.textContent = ''
  detail.style.display = 'none'
  const hideDetail = () => { detail.style.display = 'none' }
  const showDetail = (event, text) => {
    detail.textContent = text
    detail.style.display = 'block'
    const parent = detail.parentElement
    const parentBounds = parent.getBoundingClientRect()
    const bounds = detail.getBoundingClientRect()
    const left = Math.max(6, Math.min(event.clientX - parentBounds.left + 12, parentBounds.width - bounds.width - 6))
    const top = Math.max(6, Math.min(event.clientY - parentBounds.top + 12, parentBounds.height - bounds.height - 6))
    detail.style.left = `${left}px`
    detail.style.top = `${top}px`
  }
  ring.onpointermove = (event) => {
    const bounds = ring.getBoundingClientRect()
    const x = event.clientX - bounds.left - bounds.width / 2
    const y = event.clientY - bounds.top - bounds.height / 2
    const distance = Math.hypot(x, y)
    if (distance < bounds.width * .28 || distance > bounds.width * .52) { hideDetail(); return }
    const ratio = ((Math.atan2(x, -y) * 180 / Math.PI + 360) % 360) / 360
    let cursor = 0
    const item = normalized.find((candidate) => {
      cursor += Number(candidate.ratio)
      return ratio <= cursor
    }) ?? normalized.at(-1)
    if (item) showDetail(event, `${itemLabel(item)}\n${itemDetail(item)}`)
  }
  ring.onpointerleave = hideDetail
}
