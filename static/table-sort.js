function missing(value) {
  return value === null || value === undefined || value === '' || (typeof value === 'number' && !Number.isFinite(value))
}

export function compareTableValues(left, right) {
  if (missing(left)) return missing(right) ? 0 : 1
  if (missing(right)) return -1
  if (typeof left === 'number' || typeof right === 'number') {
    const leftNumber = Number(left)
    const rightNumber = Number(right)
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
  }
  return String(left).localeCompare(String(right), 'zh-CN', { numeric: true, sensitivity: 'base' })
}

export function sortTableRows(rows, sort, read, tieBreak = () => 0) {
  const direction = sort?.direction === 'asc' ? 1 : -1
  return rows.slice().sort((left, right) => {
    const leftValue = read(left, sort?.key)
    const rightValue = read(right, sort?.key)
    const result = compareTableValues(leftValue, rightValue)
    if (missing(leftValue) || missing(rightValue)) return result === 0 ? tieBreak(left, right) : result
    return result === 0 ? tieBreak(left, right) : result * direction
  })
}

export function updateTableSortHeaders(root, sort) {
  root?.querySelectorAll('[data-sort-key]').forEach((header) => {
    const active = header.dataset.sortKey === sort?.key
    header.setAttribute('aria-sort', active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none')
  })
}

export function bindTableSortHeaders(root, getSort, onSort) {
  root?.querySelectorAll('[data-sort-key]').forEach((header) => {
    if (header.dataset.sortBound === '1') return
    header.dataset.sortBound = '1'
    const activate = () => {
      const key = header.dataset.sortKey
      if (!key) return
      const current = getSort()
      onSort(current?.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'desc' })
    }
    header.addEventListener('click', activate)
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        activate()
      }
    })
  })
}
