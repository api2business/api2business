const $ = id => document.getElementById(id)
const escape = value => String(value ?? '—').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c])
const number = (value, digits = 2) => value == null ? '未知' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits:digits })
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12:false, timeZone:'Asia/Shanghai' }) : '无证据'
const status = value => ({ met:'达标', missed:'未达标', insufficient_data:'覆盖不足' })[value] ?? '未知'
const grade = slo => `<span class="${slo.status === 'met' ? 'slo-good' : 'slo-warn'}">${status(slo.status)}</span>`
let report, page = 1
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
function render(data) {
  report=data
  const s=data.sub2api,a=data.api2business,c=data.cost,b=data.broker
  $('observability-state').textContent=`${time(data.window.start)} — ${time(data.window.end)}（北京时间） · 冻结报告 ${data.id}`
  $('observability-state').dataset.ready='true'
  $('ob-cards').innerHTML=`<article class="slo-card"><h2>Sub2API · 用户请求</h2><div class="slo-value">${number(s.successSlo.value)}% ${grade(s.successSlo)}</div><p class="slo-meta">成功率目标 ${s.successSlo.comparison === "gt" ? "&gt;" : "≥"} ${number(s.successSlo.target)}% · ${number(s.requests,0)} 个唯一请求</p><div class="slo-line"><span>失败 / 成功</span><strong>${number(s.failed,0)} / ${number(s.succeeded,0)}</strong></div><div class="slo-line"><span>TTFT P95</span><strong>${number(s.ttftP95Ms == null ? null : s.ttftP95Ms/1000)} 秒 ${grade(s.ttftSlo)}</strong></div><p class="slo-meta">TTFT 目标 ≤ ${number(s.ttftSlo.target/1000)} 秒<br>有效流式样本 ${number(s.ttftKnown,0)} / ${number(s.streaming,0)}<br>排除探活 ${number(s.excludedProbeRecords,0)} 条 · 缺少 ID ${number(s.missingRequestIdRecords,0)} 条</p></article><article class="slo-card"><h2>Api2Business · 管理接口</h2><div class="slo-value">${number(a.non5xxSlo.value)}% ${grade(a.non5xxSlo)}</div><p class="slo-meta">非 5xx 目标 ≥ ${number(a.non5xxSlo.target)}% · ${number(a.requests,0)} 个请求</p><div class="slo-line"><span>接口 P95</span><strong>${number(a.latency_p95_ms)} ms ${grade(a.latencySlo)}</strong></div><div class="slo-line"><span>历史观测覆盖</span><strong>${number(a.coverage.coveredSeconds/60,1)} / ${number(a.coverage.windowSeconds/60,1)} 分钟</strong></div><p class="slo-meta">应用层指标；公网连通性单独检查。<br>broker 运行 ${number(b.uptimeSeconds,0)} 秒<br>最近完成 ${escape(time(b.lastCompletedAt))}<br>最近失败 ${escape(time(b.lastErrorAt))}<br>状态采集 ${escape(time(b.observedAt))}</p></article><article class="slo-card"><h2>实际成本 · 证据覆盖</h2><div class="slo-value">${c.complete ? '¥ '+number(c.totalCostCny) : '总成本未知'}</div><p class="slo-meta">${c.complete ? `同窗已对账成本 ¥ ${number(c.knownCostCny)}` : `已知部分 ¥ ${number(c.knownCostCny)}，不代表完整支出`}</p><div class="slo-line"><span>记录覆盖率</span><strong>${number(c.coveragePercent)}%</strong></div><div class="slo-line"><span>已知 / 总记录</span><strong>${number(c.knownRecords,0)} / ${number(c.records,0)}</strong></div><p class="slo-meta">缺失 ${number(c.missingRecords,0)} 条。<br>未对账的 OAuth、缺失账务字段及无历史倍率证据分别保留原因。<br>不以余额差或当前倍率补写历史。</p></article>`
  $('ob-wallet-summary').textContent=`${data.wallets.walletCount} 个钱包 · ${data.wallets.accountCount} 个账号 · ${data.wallets.sharedWallets} 个共享钱包 · ${data.wallets.unknownWallets} 个未知 · ${data.wallets.staleWallets} 个陈旧 · 余额采集 ${time(data.wallets.observedAt)}`
  $('ob-details').textContent=JSON.stringify({errorFamilies:s.errorFamilies,unknownExamples:s.unknownExamples,platforms:s.platforms,costAccounts:c.accounts,sources:data.sources,broker:b},null,2)
  wallets()
}
async function load(fresh=false) {
  $('ob-refresh').disabled=true
  try {
    const id=fresh ? null : new URL(location.href).searchParams.get('report')
    const response=await fetch(id ? `/api/observability/reports/${encodeURIComponent(id)}` : '/api/observability/report',{cache:'no-store'})
    if (response.status===401) { location.assign('/login'); return }
    const data=await response.json()
    if (!response.ok || data.ok!==true) throw new Error(data.error || `HTTP ${response.status}`)
    render(data); const url=new URL(location.href); url.searchParams.set('report',data.id); history.replaceState(null,'',url)
  } catch(error) { $('observability-state').textContent=`读取失败：${error.message}` }
  finally { $('ob-refresh').disabled=false }
}
$('ob-refresh').addEventListener('click',()=>load(true))
$('ob-account').addEventListener('input',()=>{page=1;wallets()})
$('ob-filter').addEventListener('change',()=>{page=1;wallets()})
$('ob-prev').addEventListener('click',()=>{page--;wallets()})
$('ob-next').addEventListener('click',()=>{page++;wallets()})
await load()
