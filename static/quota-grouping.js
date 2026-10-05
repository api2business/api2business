function namesOf(account) {
  const names = Array.isArray(account?.groupNames) ? account.groupNames : Array.isArray(account?.groups) ? account.groups : [account?.groupName]
  return names.filter(Boolean).map((value) => String(value))
}

export function quotaGroup(account = {}) {
  const text = [...namesOf(account), account.platform, account.baseUrl].filter(Boolean).join(' ').toLowerCase()
  if (text.includes('kiro') && (text.includes('claude') || text.includes('anthropic'))) return 'claude-kiro'
  if (text.includes('claude') || text.includes('anthropic')) return 'claude'
  if (text.includes('grok') || text.includes('x.ai')) return 'grok'
  if (text.includes('不降智') || text.includes('no-degrade') || text.includes('quality')) return 'no-degrade'
  return 'codex-mix'
}

export function quotaMemberships(account = {}) {
  const memberships = new Set()
  for (const name of namesOf(account)) {
    if (/api2business-probe|自用/i.test(name)) continue
    if (!/混池|gpt|codex|claude|grok|kiro|不降智|anthropic/i.test(name)) continue
    memberships.add(quotaGroup({ groupNames: [name] }))
  }
  if (!memberships.size) memberships.add(quotaGroup(account))
  return memberships
}

export function walletQuotaMemberships(accounts = []) {
  const memberships = new Set()
  for (const account of accounts) for (const group of quotaMemberships(account)) memberships.add(group)
  return memberships
}
