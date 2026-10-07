# 固定窗口巡检

- 指标语义唯一见 [运维观测规格](../../../docs/specs/operational-observability.md)。
- Web 入口由 owning YAML 的公开域名解析，路径 `/observability`。
  - 页面 URL 的 `report` 参数读取冻结报告，刷新按钮另建最近两小时报告。
- 所有 Sub2API 数据均由单连接 broker 读取；不允许旁路 SQL。

## 最短操作

```bash
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml observability --help
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml observability check --rounds 3 --over-api --json
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml observability report --over-api --json
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml observability get --id <报告ID> --over-api --json
```

- 显式窗口同时传 `--start` 和 `--end`，使用带时区的 ISO 时间。
- 默认输出最多十条钱包及成本明细，保留总数、省略数和报告 ID。
  - 完整详情用 `--include-records`，不要把省略误判为服务端缺数据。
- `check` 逐轮保留额度、候选和 broker 的时间、耗时及错误。
  - 某次失败不会终止后续采集，也不会被后续成功覆盖。
  - 无收费推理、余额采样、充值或调度操作。
- `report` 保存观测结果；`get` 不重新计算历史报告。

## owning YAML

- `observability configure --file <JSON> --confirm` 更新 owning YAML。
  - 不传 `--confirm` 只预览。
  - 同时建立沿用现有视口的 `observability` 截图 profile。
  - 修改后使用 `native start --component all` 应用同版本配置。
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
  - 当前倍率和当前币种政策不可反填历史。
  - 已知部分可为零；完整成本未知必须保持 `null`。
- 既有 HTTP 502、后续读取成功和发布重启分别记录。
  - 仅凭最新健康正常不能追认历史根因，更不能宣称持续恢复。

## 验收

```bash
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml web screenshot --profile observability --over-api --json
```

- 截图和邮件流程复用 [项目技能](../SKILL.md)。
