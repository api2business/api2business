# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|-----------------|--------------------|
| 2026-07-31 | self | TaskTree 命令后在 `/workspace/unidesk` 继续读取 ApiState 源码，导致只读命令找不到文件 | TaskTree 操作和 ApiState 开发分开调用，并为每次命令显式设置正确工作目录 |
| 2026-07-31 | user | OAuth 产出展示曾使用“全局固定预期”，且第三个值只放在次级说明中 | 统一使用“当前产出 / 实时预期 / 初始预期”，三值在顶部摘要和表格主行直接并列；初始预期固定为 100% |
| 2026-07-31 | user | 日毛利核算把负的余额负债变化钳制为零，导致计提后利润没有释放准备金 | 待兑现成本变化必须保留符号：`(期末正余额 - 期初正余额) × 成本率`，负数从现金毛利中相减时会提高调整后利润 |
| 2026-07-31 | self | 把“补算已有 Hubway 成本”误解成新增充值记录，短暂追加了重复账目 | 先跨 YAML、JSONL 和手工账本核对同日来源；“补算”默认改善汇总口径，只有用户明确新增交易时才写新账目 |
| 2026-07-31 | self | 0 元采购项缺少 YAML 必填的 `accountName`，导致结算后的 runtime 删除在配置预检阶段失败 | 零成本仍是完整采购记录；写入后先跑受控 runtime 配置解析，再执行批量 mutation |
| 2026-08-01 | self | 在单引号包裹的 `bun -e` 中嵌入 SQL 单引号，shell 截断后造成 `%` 附近语法错误，并一度误判为字段类型问题 | 临时只读 SQL 的字面量也全部参数化；先看受控 API 日志再归因 |
| 2026-08-01 | self | 把 ApiState L1 聚合生命周期误写为不支持的 `native restart` | ApiState 聚合重载固定使用 `native stop --component all` 后接 `native start --component all`，再查聚合状态 |

## User Preferences
- 非 OAuth 上游先按账号评分排序，再把排序归一化到优先级 100 至 300。
- OAuth 不参与自动调优：快刷账号可人工设为小于 100，兜底账号可人工设为大于 300。
- 局部排序变化应尽量只影响局部优先级，避免全池频繁写入。

## Patterns That Work
- ApiState L1 运行与验收使用项目 CLI 和 `--over-api`，不裸调运行组件。
- 大批量 runtime 删除即使 CLI 因输出预算返回失败，也必须通过 ApiState 排队数据库回读判断真实终态。

## Patterns That Don't Work
- 不在 TaskTree 的 `/workspace/unidesk` 工作目录中顺带执行 ApiState 源码命令。

## Domain Notes
- Sub2API 优先级数字越小，调度越靠前。
- Sub2API `/v1/usage` 的 `mode=unrestricted` 只表示 API Key 不受 quota/rate-limit；只有顶层 `remaining`/`balance` 或 `subscription`/`usage.total` 才是可展示的额度与用量数据，空 mode 响应必须继续探测其他协议并报不支持。
