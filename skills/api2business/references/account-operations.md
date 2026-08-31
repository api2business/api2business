# 账号操作

- JSON、NDJSON、对象数组和 ZIP 导入先预检、聚合、去重和生成计划，再使用原生批量接口写入。
- 类型、单价、分组、并发、优先级和代理策略必须在确认时再次展示；默认代理策略为直连。
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

- 只探测 `status=active` 且 `schedulable=true` 的正常账号。
- 每轮通过排队数据库读取生成稳定计划，不由探活流程解除异常状态。
- 对计划内账号并发请求普通业务端点，并为每个请求加入独立随机抖动。
- 单账号每轮只请求一次，不在当前轮重试。
- 上一轮未结束时跳过新一轮，避免死锁和重试风暴。
- 充值后的恢复由充值流程处理，不与空闲探活耦合。
- 探活请求进入普通用量和错误记录，不额外直读结果。
