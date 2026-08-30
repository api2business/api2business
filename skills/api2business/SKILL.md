---
name: api2business
description: >-
  Api2Business 开发、配置、部署和运行维护技能。用户要求安装、部署、升级、验证、
  排查 Api2Business，或操作账号、评分、上游、成本和经营核算时使用。
---

# Api2Business

## 当前 Sub2API 架构

- 唯一 Sub2API 运行面是 NC01 的 `sub2api-nc01-native`。
- 唯一 Sub2API 业务数据库是 NC01 本地专用 PostgreSQL
  `127.0.0.1:55432/sub2api`。
- `api.pikapython.com`、`api.hwpod.com` 和 `sub.api2business.com` 只是入口或代理，
  不代表数据库 authority。
- 禁止将旧 PK01 或 `NC01-DOCKER` 的数据库地址写入配置、Secret、CLI 参数或示例。

## 工作区

- 新部署先克隆 `https://github.com/api2business/api2business.git`，再从克隆后的仓库加载本 skill。
- 从当前 Api2Business 仓库根目录执行命令。
- 使用 `config/api2business.yaml` 保存本地配置；该文件不得提交。
- 使用 `skills/api2business/scripts/api2business-cli.ts` 执行业务和生命周期操作。

## 从零部署（Bootstrap）

1. 准备 Git、Bun、PostgreSQL、Temporal 和可访问的 Sub2API 管理面。
2. 克隆仓库并进入工作区：

   ```bash
   git clone https://github.com/api2business/api2business.git
   cd api2business
   ```

3. 从克隆后的仓库加载 `skills/api2business/SKILL.md`，再读取
   `docs/reference/deployment.md`；不得从其他仓库或运行容器复制部署逻辑。
4. 安装依赖并创建不提交的本机配置：

   ```bash
   bun install --frozen-lockfile
   cp config/api2business.example.yaml config/api2business.yaml
   ```

5. 在仓库外准备 Secret 和持久化状态目录：
   - Secret 文件仅允许 owner 读取；
   - 配置只保存 `sourceRef`、环境变量名或挂载路径；
   - PostgreSQL 经营数据、账本、缓存和采样不得写入 Git 工作区。
6. 根据目标环境填写 `config/api2business.yaml`，再执行：

   ```bash
   bun skills/api2business/scripts/api2business-cli.ts \
     --config config/api2business.yaml \
     config validate
   bun run deploy:validate
   bun skills/api2business/scripts/api2business-cli.ts \
     --config config/api2business.yaml \
     native start --component all
   bun skills/api2business/scripts/api2business-cli.ts \
     --config config/api2business.yaml \
     native status --component all --json
   ```

7. 按“验收”章节完成检查：
   - 检查登录、主要数据页和至少一个异步作业；
   - 检查重启后的账本、缓存、采样和作业状态；
   - 任一步失败时停止在首个断点，不跳过配置或 Secret 校验。

## 部署

- 先读取 `docs/reference/deployment.md`。
- 确认当前目录是已克隆的 Api2Business Git 工作区，不从运行容器或其他仓库拼装部署资产。
- 根据目标环境选择 Compose、Kubernetes、systemd、托管容器或其他部署方式。
- 不假定特定 CI/CD、代码托管、集群、主机名或网络入口。
- 发布前执行 `bun run deploy:validate`。
- 使用镜像摘要和配置摘要确认运行版本，禁止使用运行容器作为配置真相。

## Secret

- Secret 只保存在仓库外。
- 通过配置中的 `sourceRef`、环境变量、只读文件或外部 Secret 管理器注入。
- 只输出 presence、fingerprint 和有界摘要，不输出值。

## 生命周期

```bash
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml native start --component all
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml native status --component all
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml native logs --component all --tail 100
bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml native stop --component all
```

- `native` 是统一生命周期入口，实际运行方式由配置选择。
- API 应快速返回作业 ID，长流程由 worker 执行。
- 数据库读取使用应用内排队读取通道，不从外部脚本直接连接业务数据库。

## 领域操作

- 账号导入、生命周期和空闲探活读取 `references/account-operations.md`。
- 账号导入可用历史参数名 `--rate-multiplier <正整数>` 调整负载因子；该参数在导入
  payload 中必须写入 Sub2API 原生 `load_factor`，不得写入计费倍率
  `rate_multiplier`。省略时读取 `operations.accountImportDefaults.rateMultiplier`，普通导入与
  BugTeam 购买导入共用该字段。
- OAuth 退役计划可用 `--plan-type` 限定账号类型：
  - 默认 `--selection dead` 选择错误账号；`free`、`plus` 和 `team` 的限流账号也按死亡处理，`k12` 限流账号保留；
  - 显式 `--selection all` 选择指定单一类型的全部当前账号，且只允许用于整池范围。
- 退役清理边界：
  - 用户说“清理账号”或“退役账号”时，只允许处理 `platform=openai` 且 `type=oauth` 的账号。
  - API-key 账号禁止进入退役结算、删除或清理流程，即使它们属于同一业务池。
  - API-key 账号只能通过独立的上游管理流程处理，不得使用 OAuth 生命周期入口替代。
- 对缺少采购成本记录的整池账号，先用 `--scope pool --plan-type <type> --unit-cost-cny <CNY>`
  显式声明本批结算单价；该模式只支持单一账号类型，并在计划与确认回读中固定成本。
- 退役删除按 `operations.accountLifecycle.deleteBatchSize` 分批调用原生批量接口；单批失败会跳过并继续，终态只以排队回读为准，失败且有剩余账号时复用原计划恢复。
- 上游、评分和优先级读取 `references/upstream-scheduling.md`。
- 池级质量调查使用 `scores pool-quality --over-api`，账号分项使用
  `scores rank --calls <N> --over-api`；两者均为只读查询。
- 充值候选使用 `upstreams recharge-candidates --over-api`；同时分析当前欠费和最新额度低于 YAML `lowBalanceCny` 的账号，分别回看锚点前 `lookbackHours` 小时。
- 充值使用 `upstreams recharge --base-url <https-url> --recharge-cny <CNY> --confirm --over-api`；同一规范化 `base_url` 是共享钱包，只记账一次并统一恢复该站点全部 API-key 账号。
- 充值确认后 CLI 立即返回异步 workflow ID，并做一次非阻塞只读状态与账号快照核验；最终一致性使用 `upstreams recharge-status --id <workflow-id> --over-api`。
- 核验状态为 `pending`、`snapshot_mismatch` 或 `unavailable` 时，只表示作业未完成或读模型暂未追上，不代表充值失败；必须继续查询原 workflow。
- 充值请求超时重试时必须复用相同的 `--idempotency-key`，禁止生成新 key 重复提交同一笔充值。
- CLI 在提交传输异常时会回显本次幂等键和“结果未知”提示；只有复用该键重试，不能把传输异常当成未提交而生成新键。
- 精确错误链使用 `errors diagnose --request-id <request-id> --over-api`；输出会区分模板未命中、模板命中后切号耗尽和已恢复。
- 一次性排障优先使用 `errors inspect --request-id <request-id> --over-api`；CLI 会并行取得诊断链和请求详情，避免手工串联 `errors diagnose` 与 `errors get`。
- `errors diagnose --request-id` 和 `errors get --request-id` 会返回限长脱敏的 `responseEvidence`，包含来源、长度和摘要；正文缺失时明确显示 `available=false`，不得据此臆测上游业务原因。
- 切号模板只在确认为响应提交前未触发且运行态规则缺失时增强；
  已触发切号但候选耗尽不通过模板扩张处理，详见 `references/upstream-scheduling.md`。
- 模板同步使用 `upstreams template --confirm --over-api`，默认只处理 API-key 上游账号，完成后必须查询原 `workflow status` 回读 `verifiedCount`、`failedCount` 和 `misalignedCount`。
- 新增上游时省略 `--rate`，由 YAML 提供创建占位费率；worker 创建成功后自动探测额度与有效倍率，并将有效倍率同步为最终费率。
  倍率写回使用 Sub2API 原生批量更新并做排队回读，超时只保留可见 warning，不重复创建账号。
- 已有上游分组调整使用 `upstreams update --id <account-id> --groups <id,id,...> --confirm --over-api`，
  通过原生批量更新替换业务分组并在原异步作业终态回读。
- 多个同钱包 API Key 只对实际充值动作记一笔充值；创建、模板和探活隔离作业按账号 ID 幂等回读。
- 收入、采购、充值、退款和毛利读取 `references/accounting.md`。
- 手工收入明细使用 `cash ledger --period YYYY-MM --over-api`，汇总使用 `profit daily`。
- BugTeam 客户 API 使用 `bugteam` CLI 命令组，配置中的 `bugTeam.customerToken`、`customerAccount`、`customerPassword` 只能引用仓库外 Secret：
  - 只读：`bugteam login`、`balance`、`inventory --product <id> --quantity N`、`shelves --product <id>`、`pickup order-status --id <id>`、`recoveries list`。
  - 实时成本：`bugteam cost-monitor get --over-api` 读取最新摘要，显式增加 `--include-records` 才展开 6 小时历史；`bugteam cost-monitor sample --over-api` 提交一次采样，并用返回的 workflow ID 查询原作业。
  - 订单：`pickup order-create --product <id> --quantity N [--idempotency-key <key>]`；创建必须 `--confirm`，超时不得重复下单。
  - 履约：`pickup download --id <id> --format sub2|cpa --output <path>`、`pickup push --id <id> --hub-id <id> --confirm`、`pickup take --id <id> --confirm`。
  - 401 修复：`recoveries claim --id <id> --ticket-stdin --output <path> --confirm`，Ticket 从 stdin 读取，必须复用同一 `--idempotency-key` 进行重试。
  - 余额兑换：`redeem --code-stdin --confirm`，CDK 不得出现在 argv、日志或输出中。
  - 一键购买导入：先用 `bugteam purchase-import options --over-api` 回读默认值；
    再用 `bugteam purchase-import create --quantity N --confirm --over-api` 提交，
    并只用 `bugteam purchase-import status --id <job-id> --over-api` 跟踪原作业。
  - 下载和领取只输出路径、字节数、SHA256 与版本摘要，绝不输出账号 JSON、Token 或 Ticket。
- 30d.team 公开兑换找回使用独立的 `bugteam public-recovery` 命令组，不读取或发送 BugTeam 客户 Token：
  - 健康检查：`bugteam public-recovery health --base-url https://30d.team --card-code-stdin`。
  - 401 找回：先不带 `--confirm` 查看计划，再追加 `--confirm` 和 `--mode 401` 执行；兑换码只能经 stdin 输入。
  - 状态查询：`bugteam public-recovery status --base-url https://30d.team --card-code-stdin`，只输出脱敏状态，不输出下载 Token。
  - 下载：`bugteam public-recovery download --base-url https://30d.team --card-code-stdin --output <path>`；先查询可下载任务，成功后原子写入并返回字节数与 SHA256，已存在目标文件会拒绝覆盖。
  - `--base-url` 必须是无凭据、无路径、无查询和无片段的 HTTPS origin；该公开服务与 Api2Business 客户 API、Sub2API 本体均保持边界分离。
  - 完整复活作业使用 `start --account-id <Sub2API账号ID>`，按健康检查、401 找回、进度查询、下载、账号导入和终态回读顺序执行；导入前要求目标账号存在且为 OAuth；原账号不删除，新复活账号固定按 `¥0.01` 成本导入。
  - 已有下载文件需要补导入时使用 `import --account-id <原OAuth账号ID> --file <JSON> --plan-type <type> --confirm`；该入口保留原账号并创建独立复活副本。
  - 作业 ID、阶段、错误和脱敏日志保存在 `.state/public-recovery/<job-id>.json`；使用 `status` 查看摘要，使用 `logs --id <job-id> --limit N` 查看最近日志。
  - 作业失败后使用 `continue --id <job-id> --confirm` 从失败阶段继续，或使用 `retry --id <job-id> --stage <stage> --confirm` 单步重试；需要公开接口的阶段再次使用 `--card-code-stdin`，兑换码不落盘。
  - 完整复活导入显式使用 `cutoffTrigger=public-recovery` 和独立重复导入语义，保留原 OAuth 账号并创建新的复活账号；不会触发 OpenAI OAuth 导入后的 API-key 上游切断。
- 错误聚合与诊断：
  - `--group` 按错误记录的实际请求分组筛选；
  - 默认排除内部 monitor 用户和 `api2business-probe-*` 探活流量；
  - 返回 `groupFilterBasis=request-group` 与 `probeNoiseExcluded=true` 供调用方核对口径。
- 页面数据快照统一写入 host PostgreSQL：
  - API 与 Worker 按稳定快照键共享成功载荷；
  - 快照型 API 不再叠加通用 HTTP 响应缓存；
  - 成功后原子替换，失败保留上一份成功快照；
  - 账号评分默认每 5 分钟刷新，并在进程重启后优先回显持久化快照。
- Sub2API 业务查询统一通过 Api2Business 排队 broker 读取 NC01 本地专用库；
  CLI、Web、worker 和人工脚本不得直连旧 PK01 数据库。
- 账号级代理默认策略：OAuth 导入、Plus/Team 账号和 API-key 上游默认直连，不绑定
  Sub2API Proxy；配置中的 `sourceProxyId: 0`、`proxyId: 0` 表示无代理。
- 只有用户显式选择并且 owning 配置允许时才启用账号级代理；这不影响 NC01 host-Docker
  的出网代理配置。
- 账号导入成功后异步触发一次 OAuth 实时成本采样；该采样独立于导入作业，不延长导入终态，失败只作为采样作业失败记录。
- 手动验证同一采样路径使用 `accounts oauth-runtime-sample --over-api`，返回独立 Temporal workflow ID。
- 上游智商评测：
  - 提交：`upstreams benchmark --id <account-id> --model <model> --confirm --over-api`；
  - 进度与日志：`upstreams benchmark-status --id <benchmark-run-id> --over-api`；
  - 账号历史：`upstreams benchmark-history --id <account-id> --limit 20 --over-api`；
  - 评测只复用持久化探活专用 API Key，不读取供应商原始 Key，也不轮换探活 Key。

## 验收

- 验证 `/health`、Web 登录、主要数据页和至少一个异步作业。
- 页面截图使用正式 CLI 取得临时 session，再交给受控 WebProbe：

  ```bash
  bun skills/api2business/scripts/api2business-cli.ts \
    --config config/api2business.yaml \
    --over-api \
    web screenshot \
    --profile scores-layout
  ```

- CLI 通过 `/api/login` 获取 Cookie，并只在内存中传给 WebProbe；WebProbe 不填写登录表单，Cookie 不进入 argv、日志、报告或磁盘。
- 验证重启后账本、缓存、采样和作业状态仍可读取。
- 失败时按配置、Secret、网络、数据库、worker 和外部 API 的顺序定位首个断点。
