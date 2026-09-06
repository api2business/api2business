# 账号操作

- JSON、NDJSON、对象数组和 ZIP 导入先预检、聚合、去重和生成计划，再使用原生批量接口写入。
- 类型、单价、分组、并发、优先级和代理策略必须在确认时再次展示；默认代理策略为直连。
- 普通 OpenAI OAuth 导入的模型策略：
  - 当 `credentials.model_mapping` 为空或没有有效键值时，导入器写入当前 OpenAI 模型白名单；
  - 白名单不包含 `gpt-5.6-luna`，因此该模型默认不可由此账号调度；
  - 已有有效显式映射不覆盖，API-key 和 Grok OAuth 不适用；
  - `public-recovery` 复活导入关闭该默认注入，以便严格继承原账号快照。
- 已有账号补关闭 Luna：
  - 使用 `accounts models disable-luna --accounts <id-or-range,...> --confirm --over-api`；
  - CLI 先逐个校验平台为 `openai`、类型为 `oauth`，全部通过后才调用一次原生批量更新；
  - API-key、Grok 或混合选择均不执行写入。
- 退役和结算必须先生成计划，再显式确认；默认只退役错误账号。
- 整池退役计划可通过 `--plan-type k12|plus|team|free|all` 限定账号类型：
  - `k12` 只选择错误状态；
  - `free`、`plus` 和 `team` 选择错误或限流状态；
  - 缺少采购成本的单一类型可用 `--unit-cost-cny` 显式补齐本批结算成本；
  - 未指定时检查全部类型，但仍只选择各类型的死亡状态。
  - 退役选择策略：
    - `--selection dead` 是默认策略；
    - 显式 `--selection all` 会选择指定单一类型的正常、限流和错误账号；
    - `--selection all` 只允许与 `--scope pool` 一起使用。
- 作业终态通过排队读取核对，不以 HTTP 受理或前端成功文本代替。
- `operations.accountImportDefaults.sourceProxyId: 0` 表示 OAuth/API-key 导入不绑定账号级
  Proxy；Sub2API 原生批量创建时省略创建 payload 的 `proxy_id`，更新接口使用 `proxy_id: 0`
  表示清除绑定。
- 退役删除使用 `operations.accountLifecycle.deleteBatchSize` 分批调用 Sub2API 原生批量接口；单批超时只记录失败并继续后续批次，最终以排队回读确定剩余账号。
- 结算账本按计划指纹幂等写入；失败作业存在 `remainingAccountIds` 时可从原计划恢复，不重复记账。
- API 重启会丢失尚未持久化到作业控制面的 API 进程内状态；发现此情况时禁止重建计划，先用原计划日志冻结的剩余账号范围做受控批量补偿，并记录为运行面改进项。
- 导入作业成功后独立提交一次 OAuth 实时成本采样；采样由单独 Temporal 作业执行，不阻塞导入终态，也不替代原有 5 分钟周期采样。
- 导入作业成功后不自动切断 API-key 上游；如确需切断，只能通过显式手动入口执行。
- 手动回归通过正式 CLI 提交同一采样命令，不重复导入账号。

## 公开复活导入

- `bugteam public-recovery start` 只创建作业并冻结指定 OpenAI OAuth 原账号的运行配置。
- 原账号保留，不执行删除或覆盖；新复活副本固定按 `¥0.01` 采购成本记账。
- 每次 `continue --confirm` 或 `retry --stage <stage> --confirm` 只推进一个阶段。
  - 阶段依次为 `health`、可选 `reclaim`、`status`、`download`、`import-submit`、`import-status`、`verify`。
  - 仅公开服务阶段经 `--card-code-stdin` 接收兑换码；兑换码不写入作业、日志或输出。
- 创建时冻结并对新副本继承优先级、并发、负载因子、计费倍率、分组、代理、过期暂停、状态和可调度状态。
- 导入后只对新建副本回读这些字段；未创建新副本或任一字段不一致时，作业失败，原账号不受影响。
- 复活副本允许与现有 OAuth 凭据相同，但只在 `cutoffTrigger=public-recovery` 场景启用该重复导入语义。
- 复活导入使用原账号冻结的代理设置，并跳过 OAuth 导入后的 API-key 上游切断联动。
- 已完成下载但需要补导入时使用 `bugteam public-recovery import`，仍须指定一个现存 OAuth 账号作为复活锚点。

## 空闲探活

- 探活覆盖对象是 OpenAI `type=apikey` 上游账号；Grok、Anthropic 和 OAuth 账号不套用
  这套 OpenAI Responses 探活隔离入口，必须使用各自的专用采样或评测入口。
- 账号级验收口径是：每个 `active` 且 `schedulable=true` 的目标上游在最近 20 分钟内
  至少存在一条由探活专用 Key 产生的 `usage_logs` 或 `ops_error_logs` 记录；成功和失败
  都算记录，不能用普通用户流量或仅有探活轮次汇总冒充账号级覆盖。
- `status=error` 的上游允许没有探活记录，不得为了补记录而调用恢复接口；报告中只需
  单独列出这类账号，不计入 active+schedulable 探活覆盖缺口。
- 自动探活只选择 `status=active` 且 `schedulable=true` 的账号；错误、限流或不可调度账号
  不得为了探活而强行恢复运行态，需在覆盖报告中明确列为运行态阻断。
- 每轮通过排队数据库读取生成稳定计划，不由探活流程解除异常状态。
- 自动计划只取 `candidateLimit` 个候选；候选若没有已就绪的私有分组和专用 Key，仍会
  占用计划名额并形成 `planned > ready` 的覆盖缺口。`reconcile` 不属于自动轮次，必须
  在新增账号、批量分组变更或发现未就绪账号后显式执行。
- 对计划内账号并发请求普通业务端点，并为每个请求加入独立随机抖动。
- 单账号每轮只请求一次，不在当前轮重试。
- 上一轮未结束时跳过新一轮，避免死锁和重试风暴。
- 充值后的恢复由充值流程处理，不与空闲探活耦合。
- 探活请求进入普通用量和错误记录，不额外直读结果。
- 页面“最新样本”若来自评分或普通用量聚合，不等于最后一次探活时间；排障和验收必须
  使用探活专用 Key 归因后的账号级记录查询。
