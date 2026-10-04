# 上游与调度

- 本文是 Api2Business 上游、评分、探活、切号和作用域调度的唯一详细权威。
- Api2Business `SKILL.md`、UniDesk `unidesk-sub2api` 入口和项目规格只保留路由摘要，
  不复制本文的算法、开关或终态判定。
- 余额、共享钱包别名、额度缓存和失败保留的唯一详细口径见
  [额度监控](quota-monitoring.md)；本文只引用其结果，不重新定义余额来源。
- 创建、分组、切号和配置生效在本文前半。
- 稳定性观察见下文「稳定性观察与用户报错」。
- 评分、容量与冷却见下文「评分、容量与冷却联动评估」。
- 探活覆盖见 [账号操作](account-operations.md)。

## 创建、分组与切号

- 上游创建、调整、充值、额度查询和评分统一使用 Api2Business CLI 或 API。
- 新增 API-key 上游默认直连；`operations.upstreamManagement.proxyId: 0` 表示不绑定账号级
  Proxy。该设置只影响账号到供应商的代理绑定，不改变 host-Docker 或公网 edge 的出网代理。
- 新增上游的费率处理：
  - CLI 的 `upstreams create` 默认不要求 `--rate`；
  - 创建所需占位费率只读取 owning YAML 的 `operations.upstreamManagement.createBootstrapRateCnyPerApiUsd`；
  - worker 在账号落库后自动探测额度和有效倍率，并同步最终费率；
  - 创建时未指定成本且探测不到有效倍率时，使用 owning YAML 的
    `operations.upstreamManagement.unprobedFallbackRateCnyPerApiUsd`，默认值为 `0.1`；
  - 用户显式指定成本时，探测失败保留用户指定值，不使用回退费率；
  - 同步成功必须以排队数据库写后回读一致为准，禁止只凭管理 API 成功响应判定；
  - 探测失败不得把创建标为失败，必须返回 warning，并按上述规则落费率后由后续采样重试；
  - 用户显式传入 `--rate` 时，该值也只作为探测前的临时值。
- 新增上游的性能路径：
  - API-key 账号创建使用 Sub2API 原生 `/admin/accounts/batch`；
  - 创建后的分组、Proxy、并发、优先级和切号模板使用一次 `/admin/accounts/bulk-update`；
  - 写后校验通过排队单连接数据库合并读取，禁止为每个字段分别查询；
  - 同一规范化 URL 与后缀的账号身份不依赖临时费率，重试不得因倍率已同步而重复创建；
  - 已启用探活作用域已有持久化且 ready 的私有绑定直接复用，恢复任务不得重复创建或完整
    校验探活资源；
  - URL、后缀、分组、Proxy、并发和探活绑定均已对齐的恢复请求走幂等快速返回，不重复 mutation、探测或缓存写入；
- 上游模型同步的写入边界：
  - `POST /admin/accounts/:id/models/sync-upstream` 只读取该账号上游的 `/v1/models`，本身不持久化映射；
  - 读取成功后，只能调用 Sub2API 原生 `POST /admin/accounts/bulk-update`，提交
    `{account_ids:[id], credentials:{model_mapping:<同名映射>}}`；
  - `bulk-update` 通过 JSONB 顶层合并，只替换 `model_mapping`，保留 `base_url`、API key/token、
    header、池模式及其他账号列；
  - 禁止用 `PUT /admin/accounts/:id` 提交不完整 credentials。该路径只对敏感键做保留，
    会删除未随请求提交的非敏感字段，曾导致自定义上游 `base_url` 回退到平台默认地址；
  - 每个账号先完成读取，再独立执行一次 bulk merge；空模型、读取失败或写入失败立即停止该账号，
    不清空旧映射，也不扩展到其他账号；
  - 完成后用单账号原生读取核对 `base_url`、key 存在状态、平台和映射；不得用整组截图代替回读。
- V2 模型同步按作用域独立运行：
  - 只读计划、手动执行和历史分别使用
    `GET /api/v2/upstream-scheduling/model-sync/plan`、
    `POST /api/v2/upstream-scheduling/model-sync/run` 和
    `GET /api/v2/upstream-scheduling/model-sync`；CLI 对应
    `upstream-scheduling-v2 model-sync plan|run|history`。
  - `operations.upstreamSchedulingV2.modelSync.batchSize` 限制每批账号数，
    `intervalSeconds` 从上一批完成后开始计时；自动执行只认目标作用域的
    `features.modelSyncAutomation`，不读取或修改其他作用域开关。
  - 每批写入一个轮次主记录和每账号明细。单账号读取、同步或核对失败只记录该账号，
    继续处理同批其他账号；轮次以 `succeeded`、`partial` 或 `failed` 反映真实结果。
  - 选择游标和批次结果都按作用域持久化，手动单账号试点必须先用 `plan` 核对，
    再带 `--confirm` 执行；自动批次不得绕过同一原生单账号安全边界。
- 新增上游的收口顺序：
  - 创建命令带上全部已解析的业务分组。
  - 创建作业完成后，用稳定账号 ID 回读倍率。
  - 返回快照里的费率可能仍是占位费率。
  - `detectionOk=true` 只说明探测跑过，不说明快照已是最终费率。
  - 最终费率以探测回写后的排队回读为准。
  - 回写超时不重建账号，保留占位费率，交给后续采样重试。
  - 然后只对该账号执行切号模板作业。
  - 切号模板按平台分离：`config/failover-templates/codex.yaml` 只服务 OpenAI，
    `config/failover-templates/claude.yaml` 只服务 Anthropic；Grok 保持空规则。
    `operations.upstreamManagement.templateFiles` 是两份文件的唯一配置入口，不能把
    Codex 规则复制到 Claude 账号。
  - 回读该作业的 `verifiedCount`、`failedCount` 和 `misalignedCount`。
  - 只有 owning YAML 打开该作用域 `features.idleProbe` 时，才对该账号执行
    `upstreams isolation --confirm --over-api`。
  - 启用探活时，隔离并集是当前分组、owning YAML 的
    `operations.upstreamManagement.groupIds` 以及新建的私有探活分组；未启用探活的
    作用域不创建私有探活分组。
  - 比该默认集合更多的业务分组，必须在隔离前绑上，隔离后仍要回读到。
  - 用户要的业务分组少于这个并集时，隔离完成后收回：
    - 使用 `upstreams update --id <account-id> --groups <id,id,...> --confirm --over-api`。
    - `--groups` 整表替换；启用探活的账号保留自己的私有探活分组，其他账号只保留用户
      指定的业务分组。
    - 启用探活账号漏写私有探活分组会把它从账号上拆掉。
    - 同一次更新会重写切号模板，结束后按下文模板回读再核一次。
    - 收回后不得再执行隔离，否则默认分组会再次并入。
  - 启用探活的账号绑定终态同时满足：
    - 隔离作业完成。
    - 私有分组 exclusive，且成员只有该账号。
    - 业务分组成员与用户指定一致；未启用探活的账号不检查私有分组。
  - 探活是否已经打过请求，见 [账号操作](account-operations.md)。
  - `upstreams create` 即使只做预检也必须带 `--api-key-stdin`。
    - 只有加上 `--confirm` 才读取标准输入。
  - 省略 `--groups` 时，创建 CLI 使用源码中的固定分组列表，这次解析不读取 YAML `groupIds`。
    - 用户指定了分组时，必须显式传入实时解析出的 ID。
    - 该固定列表与 YAML `groupIds` 不一致时，以用户显式 `--groups` 为准，并先修正入口。
  - 账号处于 `sub2api.priorityPlan.eligibleGroupIds` 时，自动计划可能改写 `priority`。
    - 写入范围是该计划的 `minimumPriority` 到 `maximumPriority`，数值越小越优先。
    - 隔离若暂时并入这些分组，计划可能在收回默认分组之前写下优先级。
    - 账号离开全部 eligible 分组后，该计划不再改写它，最后一次写入会保留。
    - 用户未要求调整优先级时，不把该值改回创建时的占位优先级。
- 同一充值 `base_url` 的多 Key 充值只提交一次 `upstreams recharge --base-url <https-url>`；
  - CLI 自动分页解析该站点全部 API-key 账号，并选择一个账本锚点。
  - 钱包账号列表只用于恢复范围，不重复记账。
- 余额读取的跨 host 钱包身份与 `walletKey` 规则见 [额度监控](quota-monitoring.md)。
- 同一规范化 `base_url` 视为同一充值钱包；充值恢复只按该地址选择账号，不因余额读取的
  `walletKey` 别名扩大写入范围。Codex、Claude 与 Grok 的余额可以共享，但账号恢复和
  充值写入仍必须按充值地址与显式账号范围执行。
- 充值完成后，批量恢复该规范化 URL 下所有状态异常或不可调度的账号，写入 `status=active` 和 `schedulable=true`，再排队回读验证可以立即参与调度。
- 充值恢复使用一次 Sub2API 原生 `/admin/accounts/bulk-update`，禁止逐账号调用状态和可调度接口；充值记账保持幂等，写后只做必要的排队回读。
- 充值 mutation 仍然是 fire-and-forget；CLI 提交后只做一次有界的 workflow/status 与钱包账号快照读取，不等待 worker 完成。
- CLI 的 `recharge-status` 使用原 workflow ID 比较记账 mutation、`entryId`、`operationId`、充值金额、锚点账号累计充值/笔数、状态、可调度性和共享钱包账号集合。
- `snapshot_mismatch` 只表示充值作业已完成但读模型仍是旧快照或出现字段不一致，不应据此判定充值失败；继续查询原 workflow 即可。
- mutation 请求超时后只能复用原 `--idempotency-key` 重试；状态查询只复用原 workflow ID，禁止以新 key 再提交。
- CLI 提交传输异常时保留并回显本次幂等键，明确标记结果未知；不得把该异常解释为充值未发生。
- API key 只通过标准输入或受控请求传入，不进入 argv、日志和账本。
- 作业输出里出现的 key 材料先脱敏，再保留日志或交付文本。
- 业务分组以实时分组为准：
  - 经排队读取查询未删除且 active 的分组。
  - 名称含 `probe-` 的分组是私有探活分组，不当作业务分组。
  - `upstreams options` 的静态清单不是分组权威。
  - 口语只在唯一命中时对应名称：
    - 自用：名称就是「自用」。
    - 混池：名称包含「混池」。
    - 保智商：名称包含「保不降智」。
  - 命中 0 个或超过 1 个时停止并询问。
  - 不新建分组，也不把现场数字 ID 写进本技能。
  - owning YAML 的 `groupIds` 只参与隔离并集，不是省略 `--groups` 时的创建来源。
  - 用户点名的分组必须全部经 `--groups` 传入。
- 切号模板匹配边界：
  - 原生能力：
    - 只有 `error_code + keywords + duration_minutes`；
    - 匹配方式是同状态码下的响应体包含关系；
    - 不支持端点、错误阶段或排除条件。
  - 关键词规则：
    - 保留既有切号模板关键词，模板同步不得因为本地校验而静默删词；
    - 普通 `model_not_found`、`model not found` 不得写入模板，因为客户请求了全池都不存在的模型时，切号不能恢复请求。
    - 同状态码的精确规则放在通用规则之前；原生按声明顺序触发冷却。
    - 正文已含 `upstream_error` 时，原有通用规则可能已经覆盖；新增精确规则的作用可以是
      区分冷却时长，不能仅凭未观测切号断言旧模板漏配。
  - 模型错误：
    - `selected model is at capacity` 表示模型或容量临时异常，可以切号；
    - `404 model_not_found` 不进入模板，直接保留标准模型错误。
    - 仅当 `400` 正文包含 `unknown provider for model gpt-5.6-terra` 或
      `unknown provider for model gpt-5.6-sol` 时，才按当前上游不支持目标模型处理；这是账号级上游能力不匹配，可以短暂冷却当前 API-key 账号并切换候选。
    - 不将通用 `unknown provider for model`、`model_not_found` 或 `model not found` 作为关键词，避免把其他模型的错误误判为可由切号恢复的问题。
    - `400 No tool call found for function call output` 是用户明确选择的短暂切号例外：
      只匹配这条完整、稳定的上游短语，按 3 分钟冷却当前 API-key 账号；不得扩展为泛化的工具调用或 `invalid_request_error` 规则。
    - `401` 的 API key 认证失效可以进入模板，并进入较长的临时冷却；
    - 400/429/502/503/504 的并发、限流和瞬态网关短语必须同时满足对应状态码，避免把普通文本错误当成账号故障。
  - 网关错误：
    - `upstream request failed` 按既有状态码模板保留，不由 Api2Business 擅自删除。
    - `upstream request failed` 配不上 `upstream response failed`。
    - 流式 `response.failed` 由 Sub2API 网关内建判定，不读取这份切号模板。
    - 因此给模板增加正文短语，不能改变已经走到该事件的切号结果。
    - 「可用渠道不存在」和 `get_channel_failed` 是渠道选择结果。
    - 响应已经写给客户端，或转发日志只是 `upstream response failed` 且没有切号切换时，
      不把这两个短语写入模板。
    - 输出开始后的 HTTP/2 `stream error` 或 `stream read error` 同样不写入模板。
    - 这些判定不修改 Sub2API 源码、测试或网关。
    - 只把已确认的响应体精确短语加入对应状态码。
    - JSON 里的 `code` 字段不是自动关键词。
    - HTTP 400 不因为正文出现 `upstream_error` 就把该码加进 400 规则。
    - `upstream_error` 维持在既有的其他状态码规则里。
    - HTTP 400 返回包装层错误时：
      - `bad_response_status_code` 是 Sub2API 规范化后的错误码，不一定存在于用于模板匹配的上游原始正文；
      - 上游原始正文为 `openai_error` 时，视为包装层瞬态故障；
      - 使用不超过 3 分钟的短冷却；
      - `openai_error` 只允许用于 HTTP 400 规则，不得扩展到其他状态码。
      - 供应商返回 `ran out of room in the model's context window` 时允许切号；
        该短语只允许用于 HTTP 400 的 3 分钟短冷却。
      - 不使用宽泛的 `context window`、`context_length_exceeded` 或
        `maximum context length`，避免把请求本身确定性超长误判为账号故障。
    - `502` 的过载、容量、限流、余额故障以及未开始输出前的流断开统一使用不超过 3 分钟的短冷却；
      Claude 的 `upstream access forbidden` 明确表示上游权限或账号状态拒绝，使用 10 分钟冷却，
      不与普通瞬态 `502` 混用。
    - 具体切号效果以 Sub2API 当前原生匹配语义和真实回读为准。
  - 切号处理决策：
    - 先用 `errors diagnose` 读取精确请求链，需要详情时再用 `errors inspect`。
    - 区分已观测切号、输出后抑制、客户端断开、成功记录关联和未观测切号。
    - `failover_event` 只能证明发生切号，不能证明自定义模板命中。
    - 没有切号事件、没有关联成功记录或上下游状态码不同，均不能证明模板漏配或候选耗尽。
    - 只有响应提交前未发生切号，且证据证明运行态缺少对应状态码或关键词时，才增强模板。
    - 模板增强只作用于 API-key 上游。
    - 先按文末「配置生效」确认持有规则的进程已加载新声明，再同步。
    - 模板变更的应用范围：
      - `upstreams template --confirm --over-api` 覆盖目标 OpenAI/Anthropic API-key 上游。
      - Grok 保持不套模板。
      - 只改 Claude 时，先按 `platform=anthropic` 和 owning 分组筛出账号，再传 `--accounts`。
      - 不得把 Codex 或 Grok 混入 Claude 作业。
    - 只给新账号套用现有模板时，加上 `--accounts <id>`，不重写全池。
    - 回读原 workflow 的 `verifiedCount`、`failedCount` 和 `misalignedCount`。
    - `verifiedCount` 只证明执行进程自校验。
    - 自校验通过后，仍用排队读取核对目标账号的状态码和精确短语。
    - 库存规则是配置加载后的 `error_code`、`keywords`、`duration_minutes` 和 `description`。
    - 比较时按对象键排序。
    - 未排序的字符串相等，或未经过加载器的 camelCase YAML，都会造成假性不一致。
    - 回读只取关键词是否存在，不查询 `api_key`，也不取出整份凭据。
    - `no available accounts` 必须先按错误阶段区分：`phase=routing` 且没有账号 ID 是全局
      选号失败，不走账号模板；`phase=upstream` 且已有账号 ID 时，表示该上游返回了同名错误，
      可以在对应平台模板的匹配状态码下短暂冷却当前账号并继续切号。
    - 模板已命中但全局候选仍耗尽时，应继续调查候选账号状态、模型支持、额度和调度容量，
      不通过扩大匹配范围掩盖候选池不足。证据不足时保持未知，也不把已提交的流式响应归因于模板漏配。
  - 数据口径：
    - `/models`、billing、failover 中间事件和其他非最终用户可见记录不作为模板匹配或评分输入；
    - 用户余额或预扣额度不足先按 Sub2API 的 `is_business_limited` 事实及统一余额关键词归类为
      `customer-billing`，保留在错误审计中但不计入账号失败率、切号失败率、TTFT 质量样本或池级综合分；
      这类错误没有账号归属时不得扣到任何账号；
    - 错误聚合与诊断按错误记录的实际请求分组筛选，默认排除内部 monitor 用户和
      `api2business-probe-*` 探活流量；
    - 最终错误仍由 Sub2API 运行面产生；
    - Api2Business 只负责模板声明、批量写入和回读校验。
- 调度先按账号质量和成本形成排序，再生成有界优先级计划。
- 最终调度分只使用严格线性加权：
  - `S = wR*R + wL*L - wC*C + wE*E + wX*X + wB*B`；
  - 各输入先归一化到 `0–100`，成本 `C` 是线性扣分；
  - 禁止置信度乘总分、池分与账号分相乘、动态质量反馈和新增硬门槛。
- `R` 与 `L` 分别由 `reliabilityWeight`、`latencyWeight` 调度：
  - TTFT 以 usage/error 记录中的非空 `first_token_ms` 为唯一证据；只要存在至少一个有效样本，就计算并输出 TTFT P95，不能被 `stream` 标志或固定最小样本数再次拦截；
  - 没有任何有效 `first_token_ms` 时，`L` 才使用 YAML `ttftPriorScore`，完整保留延迟权重与分母并输出 `latencyEvidence=prior`；
  - Api2Business 探活请求统一使用流式 Responses；非流式请求只能产生 duration 样本，不能声称产生 TTFT；
  - 优先级计划对已观测的 `ttftP95Ms` 单独采用线性负向扣分：按对应评分策略配置的
    `ttftFullScoreMs` 至 `ttftZeroScoreMs` 绝对边界计算，低于最低边界扣 `0` 分，
    高于最高边界扣 `100` 分，中间值按比例扣分；不让单个异常慢账号改变整批基准；
    缺少可信 TTFT 集合时回退全部可用 TTFT 样本；
  - 该扣分输出为 `latencyPenalty`，并通过 `latencyWeight` 作用于综合排序；缺少
    TTFT 时保留原有延迟 prior，不将缺失样本误判为低延迟；
  - 切号分别输出 `recoveredFailoverRate`、`unrecoveredFailoverRate` 和 `effectiveFailoverRate`；有效率为 `未恢复 + 0.25 × 已恢复`，再线性计入切号分。
- `E` 是独立证据分：请求样本量占 `50%`、首 Token 样本量占 `25%`、首 Token 覆盖率占 `25%`；只影响连续排序，不做可调度硬过滤。
- 优先使用探测成本；探测成本缺失时再使用手工成本。
- 可调度候选中某个账号缺少探测和手工成本时，只要同一候选集合存在有效成本，使用该集合的算术平均成本参加排序；计划行的 `costSource` 标为 `imputed-average`，不再因为缺成本直接落到 `topk-tail`。只有整组候选都没有成本证据时，才保留无成本证据的保守尾部处理。
- 成本维度采用扣分制：以本轮可调度账号的实际人民币成本范围做线性归一化，最低成本扣 `0` 分，最高成本扣 `100` 分，中间成本按比例扣分；`costWeight` 是扣分幅度，不使用负权重。
- 成本范围的锚点优先取当前可调度、具有成本数据且满足 `requiredConfidence` 的账号：
  - 该证据集缺失或成本全部相同时，回退所有当前可调度候选的成本区间。
  - 输出 `costNormalizationRange.evidenceSource`、`evidenceCount` 与 `fallbackReason`。
  - 只有所有候选成本确实相同时，成本扣分才统一为零。
- 成本范围不再使用 P10/P90 截断，避免 `0.15` 与 `0.2` 等不同成本被同时压成 `costScore=0`；高成本账号仍可因质量和延迟保持可调度，但不会因成本维度获得奖励。
- 成本采样口径：
  - 供应商 API-USD 产出分母使用 Sub2API `usage_logs.total_cost`，即标准 API 成本；
  - 调度和产出评分不得使用 `actual_cost` 作为 API-USD 产出分母。
  - 该字段的供应商实际支出折算规则只见 [额度监控](quota-monitoring.md)，不能在此复制第二套算法。
  - `effective_rate_multiplier` 是认证 API Key 的有效计费倍率，不是人民币汇率；人民币金额必须另乘共享钱包的 `CNY/API-USD` 换算率；
  - 钱包换算率缺少可信证据时必须保留 warning/未知状态，不得把用户扣费倍率或未经确认的倍率静默当作人民币换算率。
- 池级质量的数据完整度：
  - `scores pool-quality` 统计最近窗口内用户可见错误的账号归属总数、已归属数、未归属数和完整率；
  - 未归属错误只说明运行面归因数据不完整，禁止推断或扣分到任何单一账号；
  - 该指标不参与账号优先级计算，只用于核查错误归因与观测质量。
- 评分样本范围必须按层级区分：
  - V2 是当前上游调度的作用域权威，页面和接口统一使用
    `/api/v2/upstream-scheduling/*`，数据按作用域的 `platform`、账号 ID 和
    `eligibleGroupIds` 过滤。
  - V2 是唯一上游调度运行面。旧全局页面、工作流、写入 API、CLI 命令和配置字段已经
    删除；根路径和主导航只指向 V2，旧入口直接重定向或返回未找到，不保留迁移兼容层。
    配置加载会拒绝退役字段，避免旧调度重新启动。
  - V2 工作流按作用域独立运行。每个作用域的
    `scoreRead`、`planRead`、`planWrite`、`priorityAutomation`、`idleProbe` 和
    `upstreamWrite` 都只从 owning YAML 读取，代码不得替代开关。
  - 自动探活周期使用 `operations.upstreamSchedulingV2.scopes.<scope>.idleProbeIntervalSeconds`；
    未声明时回退到 `sub2api.idleProbe.intervalSeconds`。因此调整单一平台周期时，必须保留
    其他作用域的显式值，避免改变全局默认。
  - `priorityAutomation` 是独立的周期优先级写入功能；它不等价于
    `planWrite`。周期写入仍须同时满足 `operations.writePolicy.enabled`，并按平台
    使用相应的写入开关。
  - `upstream-scheduling-v2 scopes|snapshot|plan --over-api` 是只读核对入口；
    `planWrite=false` 时 plan 必须返回 `mutation=false`，不创建写入计划。
  - 启用自动探活前，先用同一作用域显式执行一次手动探活，并核对 HTTP 结果、
    `ordinaryLogRecorded` 和探活轮次记录；手动成功后才打开该作用域的 `idleProbe`。
  - 探活候选必须按作用域平台和分组查询，模型白名单动态选择
    `sub2api.idleProbe.platformModels` 中的候选；Codex 默认按 `gpt-5.6-terra`、
    `gpt-5.6-sol` 顺序，Grok 使用 owning YAML 声明的 Grok 模型。探活失败、未就绪和
    普通记录缺失分别保留，不把工作流 `running` 当作业务成功。探针私有分组的平台、
    基础业务分组和候选账号必须来自同一作用域，Grok 不得绑定 Codex 分组。
  - 作用域探活的 plan/history 是实时读入口，必须绕过通用 API 响应缓存；缓存未刷新不能
    用“缓存尚未刷新”替代当前计划。探活记录必须持久化 `platform` 和 `ready` 状态；
    修复无平台的旧记录前，先回读原生账号平台，平台不匹配时拒绝归属。
  - `in-flight` 跳过是轮次并发保护，不是探活业务失败。轮次只有在计划中的未就绪账号不被
    计为成功，且每个已尝试账号具备普通请求记录、`ordinaryLogRecorded` 和最终轮次记录时，
    才能标记成功；HTTP 受理或工作流 `running` 不能单独完成验收。
  - V2 页面复用既有质量、趋势、参与比例、账号、错误、调整、探活和调度组件；
    后台对账结果只作为 CLI/API 证据，不投影成页面事实。
  - V2 账号、错误、调整和探活表格统一复用共享排序组件；点击表头或使用键盘
    Enter/空格切换升降序，缺失值固定排在末尾，筛选和分页在当前作用域内保持排序结果。
  - 作用域深链统一使用 `/upstream-scheduling-v2?scope=<scope-name>`；例如
    `?scope=codex`、`?scope=claude`、`?scope=grok`。首次打开、切换、浏览器前进后退和
    刷新都以 URL 中的作用域为准，未知或已停用作用域回退到 owning YAML 的默认作用域。
  - Codex、Claude 和 Grok 是平等作用域。每个作用域的平台、分组、成本、评分、优先级、
    自动调度和探活是否启用均以该作用域开关为准，不把其他作用域数据互相投影。
  - Grok 作用域使用 `platform: grok` 和 `sub2api.grokPriorityPlan.eligibleGroupIds`，
    只允许实时分组「【稳定·企业级】Grok」；「【不稳定·限时3折】grok-4.5(全都映射到
    grok-4.5)」不得进入 Grok 作用域、池质量或优先级计划。分组 ID 只从 owning YAML
    维护，不能在页面或 CLI 里另建映射。
    `grokPriorityPlan.forceNormalizedTopK: true` 让 Grok 优先级计划每次按 YAML 的
    `minimumPriority` 起始，使用规范化 top-k 值重排，避免旧优先级锚点把首位抬高；top-k
    内的值保持严格递增，超出 top-k 的账号仍落在 `maximumPriority` 尾部。
    可以独立打开 `features.priorityAutomation` 和 `features.idleProbe`；关闭探活的作用域
    快照和池质量读取不创建探活记录。手动核验任一作用域时使用
    `accounts idle-probe plan|reconcile|run --scope <codex|claude|grok> --over-api`；确认
    普通请求记录、`ordinaryLogRecorded` 和轮次记录成功后，才打开对应作用域的探活开关。
  - V2 的间隔和样本档位从 `scopes`、`snapshot` 回读；旧 priority automation 和
    priority plan 命令不再存在。
  - V2 首屏读取先返回按作用域持久化的读模型缓存；缓存未过
    `operations.upstreamSchedulingV2.readModelCacheSeconds` 时直接命中，过期时先返回陈旧
    快照并后台刷新。冷启动或显式刷新才等待重建；重建失败保留上一份快照，不把账号、额度
    或评分清空为零。页面通过 `cache.state` 显示命中、陈旧后台刷新或刚完成刷新。
  - 修改页面投影后必须更新静态资源并重新读取正式入口；CLI/API 事实先于截图，截图
    只用于人工核对真实页面。
  - `scores rank` 的单账号评分包含该账号绑定的专用探活样本，用于补足用户请求不足；
    探活产生的 502、503、524、延迟和切号结果按正常评分规则计入。
  - `scores pool-quality` 排除内部 monitor 和 `api2business-probe-*` 探活，只衡量真实
    用户业务池；比较账号分、池分和优先级分时必须同时报告样本范围。
  - 账号分、池分和优先级排序分不可互相替代，报告中必须写明查询命令、时间窗口、
    探活是否纳入及滚动或即时口径。
- 账号额度来源：
  - V2 账号余额只读取额度监控已经持久化的 `api2business_upstream_usage_cache`，与额度
    监控页面使用同一缓存口径，不为补齐 V2 快照再次请求供应商额度接口。
  - 同钱包别名、最新成功有限余额投影、失败保留和旧接口一致性统一见
    [额度监控](quota-monitoring.md)；本节只规定 V2 不得绕过该缓存。
  - 快照返回 `quotaCoverage`，包含账号总数、缓存行覆盖数、数值余额数、已知不限额数、
    不可用账号 ID、缺失账号 ID、`cacheRowsComplete` 和数值 `complete`；
    `complete=false` 时页面必须显示缺失或不可用范围，不能把未知额度当作零或最低优先级。
    账号行的 `quotaCacheStatus` 明确区分 `cached`、`unlimited`、`unavailable` 和 `missing`，
    不允许用短横线掩盖缓存状态。
  - 钱包汇总仍读取额度监控的持久化汇总；共享余额可以投影到账号行用于展示，但账号级
    用量、成本、状态和质量证据不能被钱包级余额替代。
- Claude `Upstream access forbidden` 的切号边界：
  - `config/failover-templates/claude.yaml` 已按 Anthropic 平台配置精确的 `502` 状态码与
    `upstream access forbidden` 关键词，且运行时已回读到全部 Claude API-key 账号。
  - 如果供应商返回 HTTP 200 和有效 JSON `type=error` 正文，当前非流式处理只校验 JSON，
    随后按 200 透传，不进入 HTTP 错误切号模板；不能用日志中的语义 502 推断真实 HTTP
    状态码，也不能仅凭状态差异断定是 SSE。
  - 此类 200 错误信封要实现切号，必须先在 Sub2API 网关识别错误正文并进入原生 failover
    路径，再由运行面验证。扩大 403 或增加 200 模板均不能修复绕过模板的处理路径。
  - 模板调查先同时核对 `stream`、记录状态、语义上游状态、响应正文和模板回读；模板
    本身已有精确规则且错误不进入匹配路径时，不再堆叠近义词规则。
- 充值候选分析：
  - `upstreams recharge-candidates --over-api` 同时列出当前欠费账号和最新人民币余额低于
    `operations.upstreamManagement.rechargeCandidates.lowBalanceCny` 的账号，默认阈值为 `¥10`；等于阈值不纳入低余额候选。
  - 当前错误匹配额度不足时标记为 `billing-depleted`；已知余额为零时标记为
    `balance-depleted`；已知余额大于零但低于阈值时标记为 `low-balance`。
  - 欠费账号以当前账号错误仍匹配 YAML 额度不足关键词时的最近错误为锚点；低余额账号以共享 wallet 最新成功额度采样为锚点。
  - 两类候选均只分析锚点前 `lookbackHours` 小时，默认 24 小时；锚点之后的失败不进入充值价值评分。
- 查询通过 Api2Business host PostgreSQL 最新 wallet 快照和一次 Sub2API 排队单连接查询完成；
  Sub2API 查询 authority 是 NC01 本地专用数据库，不按账号循环打数据库。
  - 历史表现排除 monitor-user 探针、Luna、模型不存在、余额不足、failover 中间事件和非业务端点，使用与账号评分相同的可计分错误口径。
  - 输出推荐分及其余额、质量、请求量、失败率、TTFT P95、API 产出和上游成本分项，推荐分只用于采购排序，不改变调度权重。
  - `retiredSuppliers` 按标准化供应商域名声明退场名单；同域名下全部现有和未来账号保留审计结果，但固定标记为 `supplier-retired`，不得进入充值推荐。
  - 排队读取超时是查询失败，不是空的欠费或低余额名单。
- 自动调整每轮有界超时，失败后跳过本轮并从结束时间计算下一轮。
- 任何真实写操作先展示计划，再显式确认并回读验证。
- 单个请求的切号判定优先使用 `errors inspect --request-id <request-id> --over-api`；该入口并行取得诊断链和请求详情。需要只看聚合诊断时才使用 `errors diagnose --request-id <request-id> --over-api`，不要用大范围错误列表推断单请求是否命中模板。
- 按模型排障使用 `errors diagnose --model <exact-model-id> --limit <N> --top <N> --over-api`。返回的模型 × 账号 × 链矩阵与样本链均来自已持久化尝试；运行面未记录的候选排除原因必须标记为未知，不能反推。
- 精确诊断中的 `responseEvidence` 只展示限长脱敏摘要；`available=false` 表示运行面没有持久化可读正文，不能把包装层错误文本当作供应商业务原因。

## 稳定性观察与用户报错

- 先固定查询来源：
  - 运行面取 owning YAML 的 `monitor.target`，CLI/API 目标取 `runtime` 配置。
  - 同时记录业务入口、精确模型、请求分组及所用认证方式；认证值不得输出。
  - 读取仍走 API 排队 broker，不因临时调查改为直连数据库。
- 截图提示只用于定位，不作为上游原因：
  - “当前模型暂时不可用”不等于模型不存在。
  - 客户端把 HTTP 400 显示成参数或格式错误时，那是网关包装，不是上游正文。
  - 模板关键词只取上游响应体里的精确短语。
  - 先取得请求 ID；缺少时用用户邮箱、时区明确的时间段和精确模型定位。
  - 截图转写的请求 ID 先用账号、精确模型和时间窗核对。
  - 单次 inspect 找不到 ID，不能直接判定请求不存在。
  - 客户端或上游返回的 Request ID 不是网关请求 ID。
  - 文件名时间只能辅助缩小范围，不能单独把相邻请求认作同一用户故障。
  - 同时保留上下游状态码；下游 `499` 与上游 `524` 可以同时出现。
  - 不仅凭 `499` 断言用户主动取消，也不把它解释为模板状态码配错。
- 观察窗口使用明确的开始、结束时间：
  - 按实际墙钟持续观察，结束时按固定窗口汇总，不用最近 N 条替代完整时段。
  - 错误诊断默认排除探针，但不默认排除管理员；与其他报表对比前核对口径。
  - 质量统计继续排除 Luna；同时区分全业务流量与 API-key 通道样本。
  - 采集最近 N 条错误会偏向失败；展示链还按未恢复、切号、尝试次数和时间排序。
  - 对采样或截断结果，不计算全量请求失败率；分别报告错误数、成功用量数和覆盖范围。
  - 用量可能以 `client:`、`local:` 等 ID 记录，错误使用另一请求 ID。
  - 关联键不一致时保留恢复未知，不按相近时间猜测同一请求；用户后续重试成功也不等于原请求切号恢复。
- 调整优先级时同时核对自动策略：
  - 隔离暂时并入自动计划分组后的优先级保留，见上文创建收口，不在这里另写一套。
  - 手工优先级可能在下一轮自动调度中被覆盖，必须回读下一轮实际结果。
  - 用户授权保留人工降权时，可使用已有 `fixedPriorities`，其他账号继续自动排序。
  - 固定项会退出动态排序；优先级取 owning 策略范围，不把现场账号或数值写成默认规则。
  - 降权只改变选择偏好；既有会话绑定、在途请求和剩余候选都可能使该账号继续承接流量。
  - 再次报错时先核对生效时间、账号状态与请求链，不把提交成功当作业务恢复。
- 模板与恢复的边界：
  - 出现 `gateway.failover_suppressed_after_semantic_output` 时，增加关键词不能让已提交响应重新切号。
  - 已归属的 internal 上游 5xx 按评分规则计入失败，不能仅因 internal 标签漏计。
  - 模板完整且降权仍不能控制持续故障时，只在用户授权范围内暂停具体通道，不扩大为整个供应商。
  - 恢复前评估自动排序会不会将故障通道重新提到前列；仅读取评分模拟不证明业务健康。
  - 获准恢复时先使用合适的低优先级，并回读状态、优先级及后续实际流量。
  - 无新增样本、无新增错误、低优先级恢复和已验证健康必须分别表述。
  - 有界观察结束后停止本轮监控；遗留风险和人工固定项在交付中明确说明，不暗示仍有后台值守。

## 评分、容量与冷却联动评估

- 先区分三类分数：
  - 账号质量分来自各账号的样本窗口；
  - 池级质量分汇总实际请求后，按 `poolScorePolicy` 重新计算，不是账号分的平均值；
  - 优先级计划使用独立的线性排序分，不能直接用质量分推断排序结果。
- 解读池分时同时报告：
  - `sampledAt`、即时分、滚动分、加权失败率与 TTFT P95；
  - 从 owning YAML 读取可靠性、延迟和基础分权重及零分边界；
  - 超过边界后该分项不再下降，分数贴近基础分不等于请求全部失败；
  - 历史失败退出窗口、延迟下降或流量迁移都可能抬高分数，不能直接归功于最近一次变更。
- 实际业务改善与评分改善分别验收：
  - 以变更生效时间切分等长窗口，统计成功用量、计分错误及被排除的用户可见错误；
  - 最近 N 条错误用于定位，不用于计算整体失败率；
  - 已有池级查询 `src/pool-quality-monitor.ts` 可经排队读取通道复用；
  - 使用最近 N 条结果覆盖固定时段时，先确认最早记录早于窗口起点；
  - 无新增错误但也无请求，不能证明恢复；原会话未重试时明确保留待验收状态。
- 高分账号承流不足时先看实际限制：
  - 原生管理 API 回读优先级、并发上限、当前并发和模型冷却；
  - 核对 `fixedPriorities` 是否让恢复健康的账号退出动态排序；
  - 同一会话反复命中旧账号时，核对调度源码中的会话绑定顺序及续期机制；
  - 降低优先级不等于迁移已有会话，不能反复扩大优先级差距替代绑定调查；
  - `account_slot_acquire_failed` 是本地并发槽位获取失败，不可仅凭包装后的 502 归因供应商；
  - 本地排队或槽位错误可能进入质量统计，报告中应与上游响应错误分开。
- 恢复动态排序使用现有配置和计划流程：
  - 仅移除用户授权账号的固定项，保留其他人工选择；
  - 重载后确认计划中该账号不再是 `priorityMode=fixed`；
  - 展示动态重新归一化涉及的账号数量，再执行现有计划确认；
  - 用不同样本窗口及原生账号回读核对最终优先级。
- 瞬态冷却与重试分开判断：
  - 自定义规则可能一次命中就冷却，并在对应路径中禁止同账号重试；
  - 已知模型的非认证错误可以只冷却账号与模型组合，不等于整账号或全池不可用；
  - 缩短高频瞬态错误冷却时，只改用户授权规则的时长，其他规则和关键词保持不变；
  - 新时长作用于之后的命中，不能假设已有冷却截止时间自动缩短；
  - 原请求重试能否成功需真实证据，不由“瞬态错误”标签推定。
  - 运行态冷却也可能由隔离探活触发，须核对请求分组再判断是否属于用户业务恢复证据。
  - 诊断正文与同请求转发日志不一致时，先核对每次尝试和响应阶段，不仅凭单个摘要扩模板。
- 网页式 404 的精准切号：
  - 先用请求 ID 确认上游真实状态和正文，客户端包装后的 502 不能替代上游 404；
  - 仅在明确授权后，为已确认的 Nginx 原生 404 HTML 结构添加规则；
  - 原生关键词是任一子串命中，不能把“404”和“Nginx”拆成两个关键词后当作同时满足；
  - 使用同时包含 404 标题及 Nginx 标记的连续片段，并按实际正文处理换行差异；
  - 不扩展成通用 404、`model_not_found` 或普通模型不存在短语；
  - 验证已捕获页面可命中、普通模型错误与错误状态码不命中，再回读运行态并复测原会话。
- 配置生效：
  - owning YAML 的 `operations.upstreamManagement.templateFiles` 是唯一模板声明；
    `codex` 文件只服务 OpenAI，`claude` 文件只服务 Anthropic。
  - 执行模板写入的是持有该快照的 API 进程。
  - 只转发作业的 Temporal worker 不持有切号规则。
  - API 按配置文件指纹热加载：校验通过后替换内存配置，并更新运行时切号规则。
  - 热加载成功的证据是文件修改之后的 `config-hot-reload` 日志。
  - 同时确认运行进程读到的配置文件已经含有新关键词。
  - 仓库路径和运行路径可以是同一文件。
  - 以热加载日志里的 `configPath` 为准。
  - 有上述证据时直接提交模板作业，不重启健康的 API。
  - 没有热加载证据时，才用 `native` 生命周期重载持有快照的 API，再提交模板。
  - 模板作业按当时内存规则写入并自行校验。
  - 终态仍要与当前 owning YAML 独立比较账号关键词。
- 业务配置热加载不要求重启 Sub2API 网关。

## 可复用任务复盘

### 有效做法

- 新增或调整作用域时先核对 owning YAML 的独立功能开关，再检查 V2 状态、业务记录和
  作用域范围；禁止通过旧全局状态推断当前作用域。
- TTFT 采样使用流式 Responses；评分只把非空 `first_token_ms` 视为首 Token 证据，至少
  一个有效样本即可计算 P95 并参与延迟分，没有证据才回退 YAML prior。
- 手动探活先验证 HTTP 结果、模型白名单、`ordinaryLogRecorded` 和轮次汇总，成功后才
  打开该作用域的 `features.idleProbe`。
- 探活模型从作用域平台白名单动态选择；Codex/OpenAI 固定按 Terra 后 Sol，Grok 和其他
  平台按各自 owning YAML 顺序；缺少成本时使用当前候选集合的平均成本并标记
  `imputed-average`。
- 生产调度由 Go Temporal worker 执行；评分、池分和优先级分保持独立，所有工作流均带有
  V2 作用域身份。
- 调整作用域探活周期时必须让旧工作流退出并启动带有新输入的工作流，不能只重启业务 API；
  周期字段和全局回退规则见上面的作用域配置条目。
- 详细规则只维护在本参考，skill、UniDesk 入口和项目规格只保留摘要并交叉引用本参考。
- 页面只展示当前作用域的评分、错误、调整、探活和调度数据；重复的只读计划表不作为第二
  个状态来源，计划 API 仅用于 CLI/API 审计。
- 探活历史查询按作用域功能开关和平台读取，不能用 Codex/Grok 的质量档位过滤掉已启用的
  Claude 记录；读模型首次为空或过期时，应等待后台刷新后按同一作用域再次读取。

### 失败或误判模式

- 非流式探活只能产生 duration，不能产生 `first_token_ms`；评分再叠加 `stream` 或固定最小
  样本门禁会把已有首 Token 证据误判为缺失。修复时先改采样请求，再让 `first_token_ms`
  成为聚合唯一证据，并保留无证据时的 prior 语义。
- 不用旧数据库里的 `combined` 或历史标签推断当前作用域；作用域由 YAML、平台和分组共同决定。
- 不把 Temporal 工作流 `running`、传输层 200、作业创建成功或截图文件存在当作业务成功；
  必须等待探活轮次终态、写后回读和账号范围核验。
- 不把通用 API 响应缓存中的旧 plan 当作实时探活计划；plan/history 必须按作用域读取最新
  读模型。记录缺少平台时，先按原生账号平台核对后再修复，不能用 URL 或历史标签猜测归属。
- `in-flight` 跳过属于并发保护，不是账号失败；计划中的未就绪账号不计为成功，普通请求记录、
  `ordinaryLogRecorded` 和持久化轮次终态缺一不可。
- 不要只改 Node 配置解析或只改 Go worker；API 校验、worker YAML 解析、工作流调度和运行
  日志必须一起核对。配置文件通过校验不能替代定时器实际周期的运行面证据。
- API、worker、Web 重启或代理短暂失败先归入运行面证据，与账号上游错误分开调查；未认证
  页面、失效 Cookie 或采集器错误不得作为 UI 业务验收证据。
- 整组没有成本证据时才进入保守尾部，不能把单个缺成本账号直接降到最低优先级；也不能用
  一个分数或一个缓存结果替代其他评分事实。
- 页面文件名与同名 JavaScript 冲突时，必须从正式入口验证 HTML 路由和静态资源，不能只验证
  开发服务器上的文件存在。
- 不把全局选号阶段的 No available accounts 当成某个上游账号故障；只有已选账号在上游
  阶段返回该正文时，才使用对应平台模板切号。

## 额度监控交叉引用

- 额度监控的状态、缓存、人民币换算和验收唯一见 [额度监控](quota-monitoring.md)。
