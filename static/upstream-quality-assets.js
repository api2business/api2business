function finite(value) {
  const parsed = Number(value)
  return value !== null && value !== undefined && Number.isFinite(parsed) ? parsed : null
}

export function normalizeSupplierWallet(value) {
  return String(value ?? '').trim().split(/\s+/u)[0].replace(/\/v1\/?$/u, '').replace(/\/$/u, '')
}

export function buildSupplierQualityAssets({
  walletDistribution = [],
  scoreRows = [],
  upstreamAccounts = [],
  consumedCny = null,
  burnWindowHours = null,
  goodScoreThreshold = 80,
} = {}) {
  const upstreamById = new Map(upstreamAccounts.map((row) => [Number(row.id), row]))
  const scoresByWallet = new Map()
  for (const row of scoreRows) {
    const score = finite(row.score)
    const upstream = upstreamById.get(Number(row.accountId))
    const wallet = normalizeSupplierWallet(upstream?.baseUrl)
    if (score === null || !wallet) continue
    const scores = scoresByWallet.get(wallet) ?? []
    scores.push(score)
    scoresByWallet.set(wallet, scores)
  }

  const items = walletDistribution.map((row) => {
    const wallet = normalizeSupplierWallet(row.wallet)
    const scores = scoresByWallet.get(wallet) ?? []
    const score = scores.length > 0 ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null
    const remainingCny = Math.max(0, finite(row.remainingCny) ?? 0)
    const schedulable = row.schedulable === true
    const good = score !== null && score > goodScoreThreshold && schedulable
    const band = !schedulable || score === null
      ? 'risk'
      : score > goodScoreThreshold
        ? 'good'
        : score >= 60
          ? 'mid'
          : 'risk'
    return { wallet, score, remainingCny, remainingUsd: finite(row.remainingUsd), schedulable, good, band, ratio: 0 }
  }).filter((row) => row.wallet && row.remainingCny > 0)

  const totalBalanceCny = items.reduce((sum, row) => sum + row.remainingCny, 0)
  const goodBalanceCny = items.filter((row) => row.good).reduce((sum, row) => sum + row.remainingCny, 0)
  for (const item of items) item.ratio = totalBalanceCny > 0 ? item.remainingCny / totalBalanceCny : 0
  const qualityBands = ['good', 'mid', 'risk'].map((band) => {
    const members = items.filter((item) => item.band === band)
    const remainingCny = members.reduce((sum, item) => sum + item.remainingCny, 0)
    return {
      band,
      remainingCny,
      ratio: totalBalanceCny > 0 ? remainingCny / totalBalanceCny : 0,
      supplierCount: members.length,
    }
  })

  const consumed = finite(consumedCny)
  const windowHours = finite(burnWindowHours)
  const burnRateCnyPerHour = consumed !== null && consumed > 0 && windowHours !== null && windowHours > 0
    ? consumed / windowHours
    : null
  const estimatedGoodAvailableHours = burnRateCnyPerHour !== null && goodBalanceCny > 0
    ? goodBalanceCny / burnRateCnyPerHour
    : null

  return {
    items: items.sort((left, right) => right.remainingCny - left.remainingCny || left.wallet.localeCompare(right.wallet)),
    qualityBands,
    totalBalanceCny,
    goodBalanceCny,
    goodBalanceRatio: totalBalanceCny > 0 ? goodBalanceCny / totalBalanceCny : null,
    estimatedGoodAvailableHours,
    scoredWallets: items.filter((row) => row.score !== null).length,
    unknownScoreWallets: items.filter((row) => row.score === null).length,
  }
}
