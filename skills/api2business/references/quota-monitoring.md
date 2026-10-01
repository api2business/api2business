# 额度监控

- 额度监控的唯一业务入口是 Api2Business 的 `/quota-monitor` 页面和对应的
  `/api/upstreams/*` 接口；数据库 authority 是 NC01 本地 Sub2API 专用库。
- Web、worker 和 CLI 只通过 Api2Business 排队读取 broker 访问数据库，不直连旧运行面或从
  Sub2API 管理 API 另取一套状态。

## 数据口径

- 钱包余额来自现有上游资产汇总的 `walletDistribution` 与 `totalRemainingCny`，单位统一为人民币。
- 同一规范化 `base_url` 的多个 API Key 合并成一个钱包行；规范化规则必须与充值和上游资产汇总共用，不能在页面另造钱包身份。
- 24 小时供应商消耗使用 Sub2API `usage_logs.total_cost`，再按每个账号自己的
  `CNY/API-USD` 换算率转为人民币；`actual_cost` 是用户/API Key 扣费，不能作为供应商成本分母。
- 一个账号挂多个分组时，按实际分组汇总且不能因分组连接重复计算；一个钱包的总消耗等于其账号消耗之和。
- 现场对账金额只能作为该时刻的核对证据，不能硬编码、缩放或写入通用规则。

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

## 复核与验收

- 先核对实时资产总额、钱包合并、账号消耗分组和状态计数，再查看截图；截图只能证明页面可见结果，不能替代数据对账。
- 刷新失败、缓存 miss、401/404 或空结果先核对运行面、语义来源、认证方式和缓存键，再判断产品业务是否失败。
- 只有页面显示四组圆盘、可用/不可用额度、账号级表格和筛选排序分页，并且刷新链路完成终态核对后，才允许按验收邮件规范交付截图。
- 详细 CLI 生命周期和通用缓存规则见 [Api2Business 技能](../SKILL.md)；上游创建、充值和调度细节见
  [上游与调度](upstream-scheduling.md)。
