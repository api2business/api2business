# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|-----------------|--------------------|
| 2026-07-31 | self | TaskTree 命令后在 `/workspace/unidesk` 继续读取 ApiState 源码，导致只读命令找不到文件 | TaskTree 操作和 ApiState 开发分开调用，并为每次命令显式设置正确工作目录 |
| 2026-07-31 | user | OAuth 产出展示曾使用“全局固定预期”，且第三个值只放在次级说明中 | 统一使用“当前产出 / 实时预期 / 初始预期”，三值在顶部摘要和表格主行直接并列；初始预期固定为 100% |
| 2026-07-31 | user | 日毛利核算把负的余额负债变化钳制为零，导致计提后利润没有释放准备金 | 待兑现成本变化必须保留符号：`(期末正余额 - 期初正余额) × 成本率`，负数从现金毛利中相减时会提高调整后利润 |
| 2026-07-31 | self | 把“补算已有 Hubway 成本”误解成新增充值记录，短暂追加了重复账目 | 先跨 YAML、JSONL 和手工账本核对同日来源；“补算”默认改善汇总口径，只有用户明确新增交易时才写新账目 |

## User Preferences
- 非 OAuth 上游先按账号评分排序，再把排序归一化到优先级 100 至 300。
- OAuth 不参与自动调优：快刷账号可人工设为小于 100，兜底账号可人工设为大于 300。
- 局部排序变化应尽量只影响局部优先级，避免全池频繁写入。

## Patterns That Work
- ApiState L1 运行与验收使用项目 CLI 和 `--over-api`，不裸调运行组件。

## Patterns That Don't Work
- 不在 TaskTree 的 `/workspace/unidesk` 工作目录中顺带执行 ApiState 源码命令。

## Domain Notes
- Sub2API 优先级数字越小，调度越靠前。
