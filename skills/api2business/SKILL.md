---
name: api2business
description: >-
  Api2Business 开发、配置、部署和运行维护技能。用户要求安装、部署、升级、验证、
  排查 Api2Business，或操作账号、评分、上游、成本和经营核算时使用。
---

# Api2Business

- 本技能遵循 Skill(cli-spec)。

## 当前 Sub2API 架构

- 唯一 Sub2API 运行面是 NC01 的 `sub2api-nc01-native`。
- 唯一 Sub2API 业务数据库是 NC01 本地专用 PostgreSQL
  `127.0.0.1:55432/sub2api`。
- `api.pikapython.com`、`api.hwpod.com` 和 `sub.api2business.com` 只是入口或代理，
  不代表数据库 authority。
- 禁止将旧 PK01 或 `NC01-DOCKER` 的数据库地址写入配置、Secret、CLI 参数或示例。

## Api2Business L1 唯一运行面

- `https://api2business.hwpod.com` 是 Api2Business 唯一 L1 实例、唯一业务入口和唯一验收入口。
- CLI 的唯一 HTTP target 使用该公网地址；不得再配置或交付 `native-api`、`production`、`local` 等并列业务 target。
- 本机监听地址、Docker Compose/native profile 和 worker 内部回环地址只是唯一 L1 实例的实现细节，不构成第二个实例。
- `localhost`、`127.0.0.1` 和嵌入式 CLI 只能用于受控故障诊断或构建检查，不得用于业务结果、截图验收或邮件交付。
- L1 的 API、Web、worker、Temporal、数据库和账本必须由同一 owning 配置和同一公网入口关联；发现数据不一致时先修复入口映射，禁止创建并列实例。

## 工作区

- 新部署先克隆 `https://github.com/api2business/api2business.git`，再从克隆后的仓库加载本 skill。
- 从当前 Api2Business 仓库根目录执行命令。
- 使用 `config/api2business.yaml` 保存唯一 L1 的运行配置；该文件不得提交。
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

- `native` 是唯一 L1 实例的生命周期入口，实际运行方式由配置选择；生命周期操作不得创建第二个业务实例。
- API 应快速返回作业 ID，长流程由 worker 执行。
- 数据库读取使用应用内排队读取通道，不从外部脚本直接连接业务数据库。

## 领域操作

- 账号导入、生命周期和空闲探活读取 `references/account-operations.md`。
- 账号导入可用历史参数名 `--rate-multiplier <正整数>` 调整负载因子；该参数在导入
  payload 中必须写入 Sub2API 原生 `load_factor`，不得写入计费倍率
  `rate_multiplier`。省略时读取 `operations.accountImportDefaults.rateMultiplier`，普通导入与
  BugTeam 购买导入共用该字段。
- 普通 OpenAI OAuth 导入若未提供有效的 `credentials.model_mapping`，自动写入当前 OpenAI
  模型白名单并排除 `gpt-5.6-luna`；已有显式映射保持不变。
- 已有 OpenAI OAuth 账号可用 `accounts models disable-luna --accounts <id-or-range,...>
  --confirm --over-api` 通过 Sub2API runtime 批量写入不含 Luna 的模型白名单；命令先校验
  全部目标均为 OpenAI OAuth，校验失败时不写入任何账号。
- 该默认限制只作用于普通 OAuth 导入；API-key、Grok OAuth 和
  `cutoffTrigger=public-recovery` 的复活导入不套用该策略。
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
- 上游、评分、优先级、探活、定时稳定性观察和截图报错归因的唯一业务权威是
  [上游与调度](references/upstream-scheduling.md)。
- 该参考同时定义 API-key 切号模板的平台边界、成本补齐、评分分层和 V2 迁移；本技能只
  保留入口和命令，不复制第二套算法或状态机。
- 池级质量调查使用 `scores pool-quality --over-api`，账号评分快照使用 `scores get`，
  需要刷新时使用 `scores rank --calls <N> --over-api`。
- V2 使用 `upstream-scheduling-v2 scopes|snapshot|plan --over-api`；作用域的
  `scoreRead`、`planRead`、`planWrite`、`priorityAutomation`、`idleProbe` 和
  `upstreamWrite` 只认 owning YAML；Codex、Claude、Grok 使用同一套平等作用域接口。
  自动探活必须先完成同作用域的手动探活核验，再打开
  `features.idleProbe`。V2 是唯一调度运行面；旧全局页面、工作流、写入 API、CLI 命令和
  配置字段已经删除，配置加载会拒绝这些退役字段，禁止兼容复活。
- 作用域自动探活周期配置在
  `operations.upstreamSchedulingV2.scopes.<scope>.idleProbeIntervalSeconds`；未声明时才
  回退到 `sub2api.idleProbe.intervalSeconds`，具体生效与工作流替换规则见
  `references/upstream-scheduling.md`。
- 充值候选使用 `upstreams recharge-candidates --over-api`。
- 欠费、低余额和查询超时的判定见 `references/upstream-scheduling.md`。
- 充值使用 `upstreams recharge --base-url <https-url> --recharge-cny <CNY> --confirm --over-api`；同一规范化 `base_url` 是共享钱包，只记账一次并统一恢复该站点全部 API-key 账号。
- 充值确认后 CLI 立即返回异步 workflow ID，并做一次非阻塞只读状态与账号快照核验；最终一致性使用 `upstreams recharge-status --id <workflow-id> --over-api`。
- 核验状态为 `pending`、`snapshot_mismatch` 或 `unavailable` 时，只表示作业未完成或读模型暂未追上，不代表充值失败；必须继续查询原 workflow。
- 充值请求超时重试时必须复用相同的 `--idempotency-key`，禁止生成新 key 重复提交同一笔充值。
- CLI 在提交传输异常时会回显本次幂等键和“结果未知”提示；只有复用该键重试，不能把传输异常当成未提交而生成新键。
- 精确错误链使用 `errors diagnose --request-id <request-id> --over-api`。
- 按模型定位使用 `errors diagnose --model <exact-model-id> --limit <N> --top <N> --over-api`。
- 单请求排障使用 `errors inspect --request-id <request-id> --over-api`。
- 切号是否命中、候选是否耗尽、正文是否缺失，只以 `references/upstream-scheduling.md` 为准。
- 切号模板的匹配、近义短语、热加载、分组口语、同步范围和新增上游收口，只以该参考为准。
- 新增上游省略 `--rate`；占位费率与最终费率回读也只以该参考为准。
- 已有上游改分组使用 `upstreams update --id <account-id> --groups <id,id,...> --confirm --over-api`。
  - `--groups` 整表替换全部分组，并重写切号模板。
  - 已启用探活账号的私有分组必须列入；隔离后的收回顺序只见
    `references/upstream-scheduling.md`。
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
  - 完整复活作业使用 `start --account-id <Sub2API账号ID> --confirm` 创建并冻结原 OpenAI OAuth 账号配置，不读取兑换码、不启动 worker；原账号不删除，新复活账号固定按 `¥0.01` 成本导入。
  - 后续每次 `continue --id <job-id> --confirm` 只推进一个阶段；`health`、`reclaim`、`status` 和 `download` 阶段才追加 `--card-code-stdin`。
  - 新副本继承冻结的优先级、并发、负载因子、计费倍率、分组、代理、过期暂停、状态和调度开关；`verify` 只核对新副本，任一字段不一致即失败。
  - 已有下载文件需要补导入时使用 `import --account-id <原OAuth账号ID> --file <JSON> --plan-type <type> --confirm`；该入口保留原账号并创建独立复活副本。
  - 作业 ID、阶段、错误和脱敏日志保存在 `.state/public-recovery/<job-id>.json`；使用 `status` 查看摘要，使用 `logs --id <job-id> --limit N` 查看最近日志。
  - 作业失败后使用 `continue --id <job-id> --confirm` 从失败阶段继续，或使用 `retry --id <job-id> --stage <stage> --confirm` 单步重试；需要公开接口的阶段再次使用 `--card-code-stdin`，兑换码不落盘。
  - 完整复活导入显式使用 `cutoffTrigger=public-recovery` 和独立重复导入语义，保留原 OAuth 账号并创建新的复活账号；不会触发 OpenAI OAuth 导入后的 API-key 上游切断。
- 错误聚合与诊断：
  - `--group` 按错误记录的实际请求分组筛选；
  - 默认排除内部 monitor 用户和 `api2business-probe-*` 探活流量；
  - 返回 `groupFilterBasis=request-group` 与 `probeNoiseExcluded=true` 供调用方核对口径。
- 页面普通读取只返回已有缓存，刷新先写缓存再读回：
  - 普通 GET 只读 `api2business_api_cache`，不重新计算；
  - 显式刷新请求携带 `x-api2business-refresh: 1`，先重算并写入该缓存，再读出刚写入的响应；
  - 排队 SQL 的普通读取只返回未过期缓存；
  - 显式刷新或缓存不存在时先查询并写入读取缓存，再返回这份缓存；
  - 不把查询结果直接返回给调用方；
  - 读取不先返回旧缓存，再在后台刷新；
  - 快照型 API 不叠加第二份通用 HTTP 响应缓存；
  - 评分表账号余额读取 `usage-cache` 快照，按评分账号 ID 查询，不依赖上游列表 HTTP 缓存是否命中；
  - API 与 Worker 按稳定快照键共享成功载荷；
  - 快照成功后原子替换，失败保留上一份成功快照；
  - 账号评分快照另由 worker 每 5 分钟刷新，进程重启后仍读取持久化快照。
- Sub2API 业务查询统一通过 Api2Business 排队 broker 读取 NC01 本地专用库；
  CLI、Web、worker 和人工脚本不得直连旧 PK01 数据库。
- 账号级代理默认策略：OAuth 导入、Plus/Team 账号和 API-key 上游默认直连，不绑定
  Sub2API Proxy；配置中的 `sourceProxyId: 0`、`proxyId: 0` 表示无代理。
- 只有用户显式选择并且 owning 配置允许时才启用账号级代理；这不影响 NC01 host-Docker
  的出网代理配置。
- 账号导入成功后异步触发一次 OAuth 实时成本采样；该采样独立于导入作业，不延长导入终态，失败只作为采样作业失败记录。
- 账号导入成功后不再自动提交 API-key 切断作业；API-key 切断仅保留显式手动入口。
- 手动验证同一采样路径使用 `accounts oauth-runtime-sample --over-api`，返回独立 Temporal workflow ID。
- 上游智商评测：
  - 提交：`upstreams benchmark --id <account-id> --model <model> --confirm --over-api`；
  - 进度与日志：`upstreams benchmark-status --id <benchmark-run-id> --over-api`；
  - 账号历史：`upstreams benchmark-history --id <account-id> --limit 20 --over-api`；
  - 评测只复用持久化探活专用 API Key，不读取供应商原始 Key，也不轮换探活 Key。
- 评分与产出分母继续使用 `total_cost`。
- 额度监控的供应商实际支出按逐条销售倍率折回后乘实时有效倍率，唯一公式和缺失处理见
  [额度监控](references/quota-monitoring.md)。
- 额度监控的状态、可用比例、钱包合并、刷新轮询和截图验收口径见 [额度监控](references/quota-monitoring.md)，不得在页面或其他文档另建第二套口径。
- 首屏性能测量使用 `upstreams quota-monitor measure --mode snapshot|source --rounds N --over-api`；`snapshot` 测缓存读模型，`source` 对照页面依赖链，输出只含耗时摘要，不展开账号或 Secret。

## 验收

- 验证 `/health`、Web 登录、主要数据页和至少一个异步作业。
- 页面截图使用正式 CLI 取得临时 session，再交给受控 WebProbe：

  ```bash
  bun skills/api2business/scripts/api2business-cli.ts \
    --config config/api2business.yaml \
    --over-api \
    web screenshot \
    --profile upstream-scheduling-v2
  ```

- CLI 通过 `/api/login` 获取 Cookie，并只在内存中传给 WebProbe；WebProbe 不填写登录表单，Cookie 不进入 argv、日志、报告或磁盘。
- 验证重启后账本、缓存、采样和作业状态仍可读取。
- 失败时按配置、Secret、网络、数据库、worker 和外部 API 的顺序定位首个断点。
