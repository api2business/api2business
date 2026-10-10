# 固定窗口巡检

- 指标语义唯一见 [运维观测规格](../../../docs/specs/operational-observability.md)。
- Web 入口由 owning YAML 的公开域名解析，路径 `/observability`。
  - 页面 URL 的 `report` 参数读取冻结报告，刷新按钮另建最近两小时报告。
- 所有 Sub2API 数据均由单连接 broker 读取；不允许旁路 SQL。

## 最短操作

```bash
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml observability --help
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml observability check --rounds 3 --over-api <absolute-http(s)-URL> --json
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml observability report --over-api <absolute-http(s)-URL> --json
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml observability get --id <报告ID> --over-api <absolute-http(s)-URL> --json
```

- 显式窗口同时传 `--start` 和 `--end`，使用带时区的 ISO 时间。
- 默认输出最多十条钱包及成本明细，保留总数、省略数和报告 ID。
  - 完整详情用 `--include-records`，不要把省略误判为服务端缺数据。
- `check` 逐轮保留额度、候选和 broker 的时间、耗时及错误。
  - 某次失败不会终止后续采集，也不会被后续成功覆盖。
  - 无收费推理、余额采样、充值或调度操作。
- `report` 保存观测结果；`get` 不重新计算历史报告。
  - 改目标后用新报告验收，不覆盖旧报告，也不使用当前规则改写旧标签。
  - 严格比较在舍入前完成；页面只负责显示报告已保存的目标与比较符。
- 报告同时保存 `businessLimitBreakdown` 和 `ttftBreakdown`：
  - `businessLimitBreakdown` 按下游用户、API Key、入口和模型统计余额不足请求，包含用户 ID、
    用户邮箱、Key 名称、首末时间和请求数；该字段不包含 Key 密文。
  - `ttftBreakdown` 按模型和上游账号统计流式 TTFT 的样本数、P50、P95 和最大值，避免少量
    慢模型样本被全局 P95 隐藏。
  - 发现成功率或 TTFT 异常时先看这两个分解，再决定是下游余额、单个供应商模型还是公共运行面问题。
  - 服务质量与下游账务的最终判定遵循 UniDesk 的
    [自动巡检服务质量归因](https://github.com/pikasTech/unidesk/blob/master/docs/reference/observability.md#自动巡检的服务质量归因)。
  - 本文只定义报告字段和 Api2Business 数据入口。

## owning YAML

- `observability configure --file <JSON> --confirm` 合并所给字段到 owning YAML。
  - 单字段变更不要求复制全部现有设置；回执返回变更前后值。
  - 例如 `{"sub2apiSuccessPercent":95}`；比较边界唯一见规格。
  - 已有截图 profile 保持原有设置，只在缺失时初始化。
  - 不传 `--confirm` 只预览。

  - 修改后使用 `native start --component all` 应用同版本配置。
  - 可选 `httpIdleTimeoutSeconds` 写入 `runtime.httpIdleTimeoutSeconds`，范围 1–255 秒。
- JSON 字段：
  - `sub2apiSuccessPercent`：Sub2API 成功率百分比目标。
  - `sub2apiTtftP95Ms`：TTFT P95 毫秒目标。
  - `api2businessNon5xxPercent`：管理接口非 5xx 百分比目标。
  - `api2businessLatencyP95Ms`：管理接口 P95 毫秒目标。
  - `walletFreshnessSeconds`：余额证据陈旧阈值。
  - `retentionDays`：管理 API 请求观测保留天数。
- 未配置时不启动请求采集，报告入口明确返回未配置。
- 独立系统目标仅用于显示；不作为调度、充值或发布门禁。

## 证据判断

- broker 的观测时间、进程身份和源查询时间分别核对。
  - 状态接口不能经过持久响应缓存；最近完成时间较旧也可能只是没有新查询。
  - 重启重置计数，不能拼接不同进程的累计值。
- 新采集部署不足窗口长度时，管理接口 SLO 显示覆盖不足。
  - 无样本、采集写入失败和重启间隙都不能显示达标。
- 共享钱包的余额只计一次，保留贡献账号、源时间与冲突标记。
  - `null` 不能经 `Number(null)` 变成零。
  - 陈旧的正余额是旧证据，不能当成此刻可用额度保证。
- 成本必须披露缺少账务字段、供应商倍率或历史币种政策的记录数。
  - 只有源证据不晚于使用记录时才能计入已知成本。
  - 优先使用已有额度采样中保存的 detected 倍率及币种换算，再按每条请求时间匹配。
  - 当前倍率和当前币种政策不可反填历史。
  - 已知部分可为零；完整成本未知必须保持 `null`。
- 既有 HTTP 502、后续读取成功和发布重启分别记录。
  - 仅凭最新健康正常不能追认历史根因，更不能宣称持续恢复。

## HTTP 慢请求

- 上游语义与复现实验边界唯一见
  [Bun HTTP 服务空闲超时](/root/unidesk/.agents/skills/docs-bun/references/server-timeouts.md)。
- 产品排查对照公开请求耗时、应用记录和代理日志。
- `runtime.httpIdleTimeoutSeconds` 与已有查询、排队预算协调，保持有界。
  - 未显式配置时从 owning CLI 时间预算派生，上限遵循 Bun 的 255 秒。
- 不把一次恢复解释为历史每一次 502 都由同一原因导致。

## 验收

- `observability verify --over-api <absolute-http(s)-URL>` 经正式 broker 执行 VALUES 夹具。
  - 不读取业务记录、不写表；覆盖窗口边界、重复 ID、重试恢复、探活与历史成本。

```bash
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml web screenshot --profile observability --id <报告ID> --over-api <absolute-http(s)-URL> --json
```

- `--account <账号ID>` 在同一冻结报告中筛选共享钱包，关联账号仍完整显示。
- 截图和邮件流程复用 [项目技能](../SKILL.md)。
