# 额度监控

- 额度监控的唯一业务入口是 Api2Business 的 `/quota-monitor` 页面和对应的
  `/api/upstreams/*` 接口；数据库 authority 是 NC01 本地 Sub2API 专用库。
- Web、worker 和 CLI 只通过 Api2Business 排队读取 broker 访问数据库，不直连旧运行面或从
  Sub2API 管理 API 另取一套状态。

## 数据口径

- 钱包余额来自现有上游资产汇总的 `walletDistribution` 与 `totalRemainingCny`，单位统一为人民币。
- 同一规范化 `base_url` 的多个 API Key 合并成一个钱包行；规范化规则必须与充值和上游资产汇总共用，不能在页面另造钱包身份。
- 24 小时真实供应商成本统一从同一条排队数据库查询读取 `usage_logs.actual_cost`，
  时间窗为 `created_at >= now() - interval '24 hours'`；失败或缺失记录不补假值。
  该字段可能包含逐条下游售卖倍率；先按每条记录的
  `actual_cost / rate_multiplier` 折回，再乘同一额度缓存中实时读取的有效倍率，
  由共享 `providerActualCostUsd` 函数完成；任一实际记录缺售卖倍率或实时倍率时留空。
- 结果再按钱包资产汇总中的 `remainingCny / remainingUsd` 换算为人民币，
  不读取 `account_stats_cost` 或标准 `total_cost` 作为实际支出，也不把缺失值回退成其他成本字段。
- 一个账号挂多个分组时，按实际分组汇总且不能因分组连接重复计算；一个钱包的总消耗等于其账号消耗之和。
- 现场对账金额只能作为该时刻的核对证据，不能硬编码、缩放或写入通用规则。

## 经验与反模式

- 正确做法：用数据库 `created_at >= now() - interval '24 hours'` 固定滚动窗口，逐条除以
  `rate_multiplier`，再乘额度缓存中同一账号的实时有效倍率。
- 正确做法：所有账号先完成供应商美元成本计算，再按共享钱包的人民币换算率合并；同一钱包只在表格中出现一行。
- 正确做法：销售倍率、实时有效倍率或钱包换算证据缺失时留空，并在状态中保留可解释的缺失原因。
- 反模式：直接汇总 `actual_cost`；Claude 等账号会把下游销售倍率重复计入，结果按倍率成倍偏高。
- 反模式：把上游 `usage.total` 当作 24 小时值；它通常是累计值，不能替代数据库滚动窗口。
- 反模式：把 `usage.today` 当作滚动 24 小时值；它是自然日窗口，跨日时会漏算。
- 反模式：把 `account_stats_cost`、`total_cost` 或账号名称后缀直接当供应商实际支出；它们分别属于账号统计、标准成本和配置提示。
- 反模式：给额度监控接口叠加通用 HTTP 快照缓存；页面会继续显示旧对账结果，必须沿用额度缓存刷新链路。

## 可用额度

- 状态必须从额度监控 SQL 返回的数据库字段读取：`status`、`schedulable`、
  `temp_unschedulable_until`、`rate_limit_reset_at`、`overload_until`、`expires_at` 和
  `auto_pause_on_expired`。
- 账号只有同时满足以下条件才贡献绿色可用额度：`status=active`、`schedulable=true`，且临时不可调度、限流、过载和过期暂停时间均未生效。
- 同钱包多个账号不能因为其中一个可用就把整个钱包标绿；按钱包内各分组账号的可用占比折算可用额度，其余为不可用额度。
- 圆盘分母是该分组的剩余额度，绿色比例是可用剩余额度除以分母，不使用消费金额计算。

## 缓存与刷新

- 普通页面打开只读取已有缓存；缓存未建立时显示明确空态，不隐式发起第二套拉取。
- 刷新必须沿用同一缓存键：先提交额度刷新作业，使用 `/api/upstreams/jobs/<id>` 轮询原作业到终态，再以 `x-api2business-refresh: 1` 读取并写回额度监控缓存，最后读取刚写入的缓存。
- 不得用 `/api/admin/workflows/<id>` 轮询上游额度刷新作业；该入口要求管理 API 凭据，会把正常刷新误判为登录失效。
- 刷新期间保留已有前端数据，只显示加载动画；刷新失败显示失败原因并恢复按钮，不清空旧数据。
- 缓存刷新成功的判定必须同时核对 `x-api2business-cache: refreshed`，随后普通读取命中
  `x-api2business-cache: hit`，不能只看 HTTP 200/202。

## 余额趋势采样

- 余额采样由 owning YAML 的 `operations.upstreamManagement.quotaSampleIntervalSeconds` 控制，当前值为
  `600`，即每 10 分钟写入一次持久化额度样本；现场修改配置后必须通过项目 CLI 重启运行面。
- 曲线读取 `/api/upstreams/quota-summary` 返回的同一缓存摘要，不另起额度拉取或缓存；前端复用
  `historyChartMarkup` 绘制 Codex 混池、不降智、Claude、Grok 四条人民币余额曲线，共用采样时间轴。
- 曲线点来自已落库的额度样本，并按当前数据库分组映射归入四组；无可用历史样本时保持空态，不以当前余额伪造历史点。
- 页面“刷新缓存视图”只读取已有缓存，不触发采样；“手动强制采样”才提交一次
  `upstream.quota.sample` 作业，终态成功后再读取同一缓存，因此手动点和定时点走同一落库与曲线链路。
- 自动刷新默认 30 秒，可切换为 60 秒或 5 分钟；刷新或采样进行中分别锁定两个操作按钮并显示旋转动画，避免重复提交。

## 复核与验收

- 先核对实时资产总额、钱包合并、账号消耗分组和状态计数，再查看截图；截图只能证明页面可见结果，不能替代数据对账。
- 刷新失败、缓存 miss、401/404 或空结果先核对运行面、语义来源、认证方式和缓存键，再判断产品业务是否失败。
- 只有页面显示四组圆盘、可用/不可用额度、账号级表格和筛选排序分页，并且刷新链路完成终态核对后，才允许按验收邮件规范交付截图。
- 详细 CLI 生命周期和通用缓存规则见 [Api2Business 技能](../SKILL.md)；上游创建、充值和调度细节见
  [上游与调度](upstream-scheduling.md)。
