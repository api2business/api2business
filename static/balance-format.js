// Keep small debts visible instead of rounding them to a misleading signed zero.
export function balanceNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  const amount = Number(value)
  const precision = amount < 0 ? Math.min(20, Math.max(digits, 8, 1 - Math.floor(Math.log10(-amount)))) : digits
  return amount.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: precision })
}
