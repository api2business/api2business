# 上游管理规格

- 本文件定义上游资产管理的边界和权威入口；可执行算法、配置字段、作用域终态、
  错误阶段与验收顺序唯一见
  [上游与调度](../../skills/api2business/references/upstream-scheduling.md)。
- 运行事实使用完整 authority tuple：
  - owning YAML 负责平台、分组、功能开关、周期和模板文件；
  - V2 作用域负责账号范围、评分、优先级、探活和深链；
  - Api2Business API/Worker 负责排队读取、长流程和最终回读；
  - Sub2API 原生接口负责账号和上游的实际写入。
- Codex、Claude 和 Grok 是平等作用域；作用域之间不得通过历史标签、URL 或混池结果
  互相推断账号归属。
- 账号创建、分组、并发、优先级、成本和切号模板必须按平台作用域收口；Codex 与
  Claude 模板分文件维护，Grok 不套用 Codex 或 Claude 模板。
- 探活必须先完成同作用域的手动核验，再由 owning YAML 的
  features.idleProbe 打开自动探活；探活记录、普通请求记录和轮次终态缺一不可。
- 共享钱包别名、账号余额投影、失败保留和额度缓存的唯一口径见
  [额度监控](../../skills/api2business/references/quota-monitoring.md)；本规格只要求
  充值账本、账号成本和质量样本保持各自边界，不把共享余额重复计入这些数据面。
- 账号质量、池级综合分和优先级排序的边界见
  [账号评分规格](account-scoring.md)；算法仍只维护在上游与调度参考中。
- 充值、模板、分组、探活隔离和优先级写入都必须先展示计划，再确认、执行和回读；
  HTTP 受理、工作流运行中或页面成功提示不能替代终态。
- API Key、Token 和其他 Secret 不进入日志、响应、账本、URL 或命令参数；只保留 presence、
  fingerprint 或有界脱敏摘要。
- 该规格不复制评分公式、切号关键词、缓存状态机或 CLI 完整用法；发生冲突时以
  上述详细权威和 owning YAML 为准。
