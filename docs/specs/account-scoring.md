# 账号评分规格

- 本文件定义评分口径；评分公式、样本分类、冷却联动和优先级计划唯一见
  [上游与调度](../../skills/api2business/references/upstream-scheduling.md)。
- 账号质量分、池级综合分和优先级排序分是三个独立结果；报告必须同时说明作用域、样本
  时间窗、探活是否纳入以及滚动或即时口径。
- 用户自己的余额不足属于 customer-billing，不扣账号质量分、切号失败率、TTFT
  样本或池级综合分；没有账号归属时也不能扣到任一账号。
- 账号评分可以纳入该账号的专用探活样本；池级综合质量排除内部 monitor 和
  api2business-probe-* 探活流量，两个层级不能互相替代。
- TTFT 样本、流式探活、延迟 prior 和作用域评分的唯一详细口径见
  [上游与调度](../../skills/api2business/references/upstream-scheduling.md)。
- 缺少单个账号成本时，只要同一候选集合存在有效成本，就使用候选集合算术平均值并标记
  imputed-average；只有整组没有成本证据时才进入保守尾部。
- 额度和评分读取失败时保留上一份成功快照，不能把未知余额或未知评分写成零分或最低
  优先级；缓存与刷新口径见
  [额度监控](../../skills/api2business/references/quota-monitoring.md)。
- 优先级自动调度必须按作用域功能开关独立运行，计划生成、写入和回读分开验收。
