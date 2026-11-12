const $ = id => document.getElementById(id)
const escape = value => String(value ?? '—').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c])
const number = (value, digits = 2) => value == null ? '未知' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits:digits })
const timeIn = (value, timeZone) => value ? new Date(value).toLocaleString('zh-CN', { hour12:false, timeZone }) : '无证据'
const time = value => timeIn(value, 'Asia/Shanghai')
const status = value => ({ met:'达标', missed:'未达标', insufficient_data:'覆盖不足' })[value] ?? '未知'
const grade = slo => `<span class="${slo.status === 'met' ? 'slo-good' : 'slo-warn'}">${status(slo.status)}</span>`
const money = value => value == null ? '未知' : `¥ ${number(value, 4)}`
const coverageText = (value, missing) => value == null ? '未知' : `${number(value, 1)}%${missing ? ` · 缺 ${number(missing, 0)} 条` : ''}`
const reasonText = value => ({ provider_rate_missing:'供应商倍率缺失', historical_provider_rate_missing:'请求时点前无历史倍率',
  billing_fields_missing:'账务字段缺失', unknown_missing_cost_evidence:'成本证据不足' })[value] ?? value
let report, probeCost, page = 1
$('ob-account').value=new URL(location.href).searchParams.get('account') ?? ''
function wallets() {
  if (!report) return
  const filter = $('ob-filter').value
  const matching=report.wallets.wallets.filter(row => !$('ob-account').value.trim() || row.accountIds.some(id=>String(id)===$('ob-account').value.trim()))
  const rows = matching.filter(row => filter === 'all' || filter === 'unknown' && row.state === 'unknown' || filter === 'stale' && row.freshness === 'stale' || filter === 'shared' && row.accountIds.length > 1)
  const pages = Math.max(1, Math.ceil(rows.length / 10)); page = Math.max(1, Math.min(page, pages))
  $('ob-page').textContent = `${page} / ${pages}`
  $('ob-prev').disabled = page <= 1; $('ob-next').disabled = page >= pages
  $('ob-wallets').innerHTML = rows.slice((page-1)*10,page*10).map(row => `<tr><td>${escape(row.walletKey)}<small>${escape(row.accountIds.join('、'))} · ${escape(row.platforms.join('、'))}</small></td><td>${row.state === 'unlimited' ? '无限额' : number(row.remainingUsd, row.remainingUsd != null && Math.abs(row.remainingUsd) < 0.01 ? 6 : 2)}</td><td>${escape(({unknown:'未知',known:'有余额',zero:'真实零',debt:'欠额',unlimited:'无限额'})[row.state])} · ${escape(({fresh:'新鲜',stale:'陈旧',unknown:'新鲜度未知'})[row.freshness])}${row.conflictingBalances ? '<small>账号证据不一致，按钱包规则选择</small>' : ''}</td><td>${row.sourceAccountId ? `账号 ${escape(row.sourceAccountId)}` : '—'}<small>${escape(time(row.sourceAt))}</small></td><td>${row.lastAttemptOk == null ? '未采样' : row.lastAttemptOk ? '成功' : '失败，保留历史余额'}<small>${escape(time(row.lastAttemptAt))}</small></td></tr>`).join('') || '<tr><td colspan="5">暂无匹配的钱包</td></tr>'
}
function probeDistribution(title, rows) {
  const values = Array.isArray(rows) ? rows : []
  return `<article class="probe-card"><h3>${escape(title)}</h3><ol>${values.map(row =>
    `<li><strong>${escape(row.label ?? row.key)}</strong><br>${money(row.costCny)} · 成本覆盖 ${escape(coverageText(row.coveragePercent, row.missingRecords))} · 占比 ${row.costSharePercent == null ? '未知' : `${number(row.costSharePercent, 1)}%`}<br><span class="probe-meta">${number(row.requests, 0)} 次请求 · ${number(row.activeAccountCount, 0)} 个账号</span></li>`
  ).join('') || '<li>暂无探活记录</li>'}</ol></article>`
}
function renderProbe(data) {
  probeCost = data
  const tz = data.timezone || 'Asia/Shanghai'
  const current = data.days?.at(-1)
  const budget = data.budget || {}
  const budgetLabel = budget.status === 'exceeded' ? '超出阈值' : budget.status === 'within' ? '阈值内' : '覆盖不足'
  $('ob-probe-state').textContent = `${timeIn(data.asOf, tz)}（${tz}） · 近 ${number(data.days?.length ?? 0, 0)} 个自然日 · 探活身份口径`
  $('ob-probe-summary').innerHTML = `<article><span>今日已知成本</span><strong>${money(current?.costCny)}</strong><small class="probe-meta">${current?.dayComplete ? '完整日' : '部分日，截至 asOf'}</small></article><article><span>窗口已知成本</span><strong>${money(data.summary?.knownCostCny)}</strong><small class="probe-meta">${data.summary?.costCny == null ? '完整成本未知' : '窗口成本已对账'}</small></article><article><span>成本记录覆盖率</span><strong>${coverageText(data.coverage?.coveragePercent, data.coverage?.missingRecords)}</strong><small class="probe-meta">${Object.entries(data.coverage?.missingReasons ?? {}).map(([reason,count]) => `${escape(reasonText(reason))} ${number(count,0)}`).join(' · ') || '无缺失原因'}</small></article><article><span>预算 / 趋势</span><strong class="${budget.status === 'exceeded' ? 'slo-warn' : 'slo-good'}">${escape(budgetLabel)}</strong><small class="probe-meta">预算 ${budget.dailyBudgetCny == null ? '未配置' : money(budget.dailyBudgetCny)} · 趋势倍数 ${number(budget.trendFactor)}</small></article>`
  $('ob-probe-days').innerHTML = (data.days ?? []).map(day => `<tr><td>${escape(day.day)}</td><td>${number(day.requests, 0)}</td><td>${number(day.inputTokens, 0)} / ${number(day.outputTokens, 0)}</td><td>${day.costCny == null ? `未知 <span class="probe-meta">(已知 ${money(day.knownCostCny)})</span>` : money(day.costCny)}</td><td>${number(day.activeAccountCount, 0)}</td><td>${escape(coverageText(day.coveragePercent, day.missingRecords))}</td><td>${day.dayComplete ? '完整日' : `部分日<br><span class="probe-meta">${escape(timeIn(data.asOf, tz))}</span>`}</td></tr>`).join('') || '<tr><td colspan="7">暂无探活记录；未知不等于零成本。</td></tr>'
  const recommendationList = budget.status === 'exceeded' && Array.isArray(budget.recommendations)
    ? `<ol class="probe-recommendations">${budget.recommendations.map(item => `<li><strong>${escape(item.title)}</strong>：${escape(item.action)} 预计节省 ${item.estimatedSavingCny == null ? '未知' : money(item.estimatedSavingCny)}（${number(item.expectedSavingPercent, 0)}%）。</li>`).join('')}</ol>` : ''
  $('ob-probe-budget').innerHTML = `<strong>预算与趋势判断</strong><br>评估日 ${escape(budget.evaluationDay ?? '未知')}：已知成本 ${money(budget.evaluationCostCny)}；近 7 个完整基准日中位数 ${money(budget.baseline7dMedianCny)}（${number(budget.baseline7dDays, 0)} 天）；趋势阈值 ${money(budget.trendThresholdCny)}。<br>${escape(budget.policy ?? '')}${budget.recommendationsAdditive === false ? ` ${escape(budget.recommendationBasis ?? '')}` : ''}${recommendationList}`
  const distribution = data.distribution ?? {}
  $('ob-probe-distribution').innerHTML = probeDistribution('按账号', distribution.byAccount)
    + probeDistribution('按账号分组', distribution.byGroup) + probeDistribution('按平台', distribution.byPlatform)
    + probeDistribution('按模型', distribution.byModel) + probeDistribution('按上游', distribution.byUpstream)
}
function render(data) {
  report=data
  const s=data.sub2api,a=data.api2business,c=data.cost,b=data.broker
  $('observability-state').textContent=`${time(data.window.start)} — ${time(data.window.end)}（北京时间） · 冻结报告 ${data.id}`
  $('observability-state').dataset.ready='true'
  $('ob-cards').innerHTML=`<article class="slo-card"><h2>Sub2API · 用户请求</h2><div class="slo-value">${number(s.successSlo.value)}% ${grade(s.successSlo)}</div><p class="slo-meta">成功率目标 ${s.successSlo.comparison === "gt" ? "&gt;" : "≥"} ${number(s.successSlo.target)}% · ${number(s.requests,0)} 个唯一请求</p><div class="slo-line"><span>失败 / 成功</span><strong>${number(s.failed,0)} / ${number(s.succeeded,0)}</strong></div><div class="slo-line"><span>TTFT P95</span><strong>${number(s.ttftP95Ms == null ? null : s.ttftP95Ms/1000)} 秒 ${grade(s.ttftSlo)}</strong></div><p class="slo-meta">TTFT 目标 ≤ ${number(s.ttftSlo.target/1000)} 秒<br>有效流式样本 ${number(s.ttftKnown,0)} / ${number(s.streaming,0)}<br>排除语音 ${number(s.excludedAudioRecords ?? 0,0)} 条 · 探活 ${number(s.excludedProbeRecords,0)} 条<br>缺少 ID ${number(s.missingRequestIdRecords,0)} 条</p></article><article class="slo-card"><h2>Api2Business · 管理接口</h2><div class="slo-value">${number(a.non5xxSlo.value)}% ${grade(a.non5xxSlo)}</div><p class="slo-meta">非 5xx 目标 ≥ ${number(a.non5xxSlo.target)}% · ${number(a.requests,0)} 个请求</p><div class="slo-line"><span>接口 P95</span><strong>${number(a.latency_p95_ms)} ms ${grade(a.latencySlo)}</strong></div><div class="slo-line"><span>历史观测覆盖</span><strong>${number(a.coverage.coveredSeconds/60,1)} / ${number(a.coverage.windowSeconds/60,1)} 分钟</strong></div><p class="slo-meta">应用层指标；公网连通性单独检查。<br>broker 运行 ${number(b.uptimeSeconds,0)} 秒<br>最近完成 ${escape(time(b.lastCompletedAt))}<br>最近失败 ${escape(time(b.lastErrorAt))}<br>状态采集 ${escape(time(b.observedAt))}</p></article><article class="slo-card"><h2>实际成本 · 证据覆盖</h2><div class="slo-value">${c.complete ? '¥ '+number(c.totalCostCny) : '总成本未知'}</div><p class="slo-meta">${c.complete ? `同窗已对账成本 ¥ ${number(c.knownCostCny)}` : `已知部分 ¥ ${number(c.knownCostCny)}，不代表完整支出`}</p><div class="slo-line"><span>记录覆盖率</span><strong>${number(c.coveragePercent)}%</strong></div><div class="slo-line"><span>已知 / 总记录</span><strong>${number(c.knownRecords,0)} / ${number(c.records,0)}</strong></div><p class="slo-meta">缺失 ${number(c.missingRecords,0)} 条。<br>未对账的 OAuth、缺失账务字段及无历史倍率证据分别保留原因。<br>不以余额差或当前倍率补写历史。</p></article>`
  $('ob-wallet-summary').textContent=`${data.wallets.walletCount} 个钱包 · ${data.wallets.accountCount} 个账号 · ${data.wallets.sharedWallets} 个共享钱包 · ${data.wallets.unknownWallets} 个未知 · ${data.wallets.staleWallets} 个陈旧 · 余额采集 ${time(data.wallets.observedAt)}`
  $('ob-details').textContent=JSON.stringify({businessLimitBreakdown:s.businessLimitBreakdown,ttftBreakdown:s.ttftBreakdown,errorFamilies:s.errorFamilies,unknownExamples:s.unknownExamples,platforms:s.platforms,costAccounts:c.accounts,sources:data.sources,broker:b},null,2)
  wallets()
}
async function loadReport(fresh=false) {
  const id=fresh ? null : new URL(location.href).searchParams.get('report')
  const response=await fetch(id ? `/api/observability/reports/${encodeURIComponent(id)}` : '/api/observability/report',{cache:'no-store'})
  if (response.status===401) { location.assign('/login'); return }
  const data=await response.json()
  if (!response.ok || data.ok!==true) throw new Error(data.error || `HTTP ${response.status}`)
  render(data); const url=new URL(location.href); url.searchParams.set('report',data.id); history.replaceState(null,'',url)
}
async function loadProbe(fresh=false) {
  const url=new URL(location.href)
  const days=Math.max(1,Math.min(90,Number(url.searchParams.get('probeDays')??7)||7))
  const query=new URLSearchParams({days:String(days)})
  const end=url.searchParams.get('end')
  if (end) query.set('end',end)
  if (fresh) query.set('refresh','1')
  const response=await fetch(`/api/observability/probe-costs?${query}`,{cache:'no-store'})
  if (response.status===401) { location.assign('/login'); return }
  const data=await response.json()
  if (!response.ok || data.ok!==true) throw new Error(data.error || `HTTP ${response.status}`)
  renderProbe(data)
}
async function load(fresh=false) {
  $('ob-refresh').disabled=true
  const results=await Promise.allSettled([loadReport(fresh),loadProbe(fresh)])
  if (results[0].status==='rejected') $('observability-state').textContent=`读取失败：${results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason)}`
  if (results[1].status==='rejected') $('ob-probe-state').textContent=`读取失败：${results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason)}`
  $('ob-refresh').disabled=false
}
$('ob-refresh').addEventListener('click',()=>load(true))
$('ob-account').addEventListener('input',()=>{page=1;wallets()})
$('ob-filter').addEventListener('change',()=>{page=1;wallets()})
$('ob-prev').addEventListener('click',()=>{page--;wallets()})
$('ob-next').addEventListener('click',()=>{page++;wallets()})
await load()
