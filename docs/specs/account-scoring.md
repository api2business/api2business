# 账号评分规格

- 评分只反映服务质量；样本不足、用户额度不足、模型路由错误和内部中间事件按统一
  评分口径排除或保留，详细分类以
  [上游与调度](../../skills/api2business/references/upstream-scheduling.md) 为准。
- 账号级评分可以纳入该账号的专用探活样本；池级综合质量排除内部 monitor 和
  `api2business-probe-*` 探活流量。两个层级必须分别披露样本口径，不能互相替代。
- 账号评分、池级质量和优先级计划使用各自的 YAML 策略；成本、延迟、可靠性、切号恢复、
  余额和证据权重的公式只维护在
  [上游与调度](../../skills/api2business/references/upstream-scheduling.md)。
- 优先级自动调度先读取评分事实、生成计划，再按作用域开关执行写入并回读终态；周期和
  写入边界服从同一作用域配置。
- 评分快照由 API 和 Worker 共享持久化成功载荷；刷新失败保留上一份成功快照。缓存、
  刷新和额度数据来源以
  [额度监控](../../skills/api2business/references/quota-monitoring.md) 为准。
