# 上游与调度

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
  - 已有持久化且 ready 的私有探活绑定直接复用，恢复任务不得重复创建或完整校验探活资源；
  - URL、后缀、分组、Proxy、并发和探活绑定均已对齐的恢复请求走幂等快速返回，不重复 mutation、探测或缓存写入；
- 新增上游的收口顺序：
  - 创建成功后先用返回的稳定账号 ID 查询倍率和余额，再批量回写探测费率；费率回写超时不重建账号，保留占位费率并等待后续采样重试；
  - 切号模板和私有探活隔离使用账号 ID 的批量作业，必须分别回读 `verifiedCount` 和隔离绑定终态；
  - 同一规范化钱包的多 Key 充值只提交一次 `upstreams recharge --base-url <https-url>`，CLI 自动分页解析站点下全部 API-key 账号并选择一个账本锚点；钱包账号列表只用于恢复范围，不重复记账；
- 同一规范化 `base_url` 视为同一充值钱包；规范化只去除末尾 `/`，不按账号平台区分，因此 Codex 与 Grok 账号均属于同一恢复范围。
- 充值完成后，批量恢复该规范化 URL 下所有状态异常或不可调度的账号，写入 `status=active` 和 `schedulable=true`，再排队回读验证可以立即参与调度。
- 充值恢复使用一次 Sub2API 原生 `/admin/accounts/bulk-update`，禁止逐账号调用状态和可调度接口；充值记账保持幂等，写后只做必要的排队回读。
- 充值 mutation 仍然是 fire-and-forget；CLI 提交后只做一次有界的 workflow/status 与钱包账号快照读取，不等待 worker 完成。
- CLI 的 `recharge-status` 使用原 workflow ID 比较记账 mutation、`entryId`、`operationId`、充值金额、锚点账号累计充值/笔数、状态、可调度性和共享钱包账号集合。
- `snapshot_mismatch` 只表示充值作业已完成但读模型仍是旧快照或出现字段不一致，不应据此判定充值失败；继续查询原 workflow 即可。
- mutation 请求超时后只能复用原 `--idempotency-key` 重试；状态查询只复用原 workflow ID，禁止以新 key 再提交。
- CLI 提交传输异常时保留并回显本次幂等键，明确标记结果未知；不得把该异常解释为充值未发生。
- API key 只通过标准输入或受控请求传入，不进入 argv、日志和账本。
- 切号模板匹配边界：
  - 原生能力：
    - 只有 `error_code + keywords + duration_minutes`；
    - 匹配方式是同状态码下的响应体包含关系；
    - 不支持端点、错误阶段或排除条件。
  - 关键词规则：
    - 保留既有切号模板关键词，模板同步不得因为本地校验而静默删词；
    - 普通 `model_not_found`、`model not found` 不得写入模板，因为客户请求了全池都不存在的模型时，切号不能恢复请求。
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
    - `upstream request failed` 按既有状态码模板保留，不由 Api2Business 擅自删除；
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
    - 具体切号效果以 Sub2API 当前原生匹配语义和真实回读为准。
  - 切号处理决策：
    - 先用 `errors inspect --request-id <request-id> --over-api` 区分模板未命中与模板命中后候选耗尽。
    - 只有响应提交前未发生切号，且证据证明运行态缺少对应状态码或关键词时，才增强模板。
    - 模板增强只作用于 API-key 上游，使用 owning 配置更新后通过
      `upstreams template --confirm --over-api` 批量同步，并回读原 workflow 的
      `verifiedCount`、`failedCount` 和 `misalignedCount`。
    - 模板已命中但候选耗尽不做模板增强；应继续调查候选账号状态、模型支持、额度和调度容量，
      不通过新增关键词或扩大匹配范围掩盖候选池不足。
    - 证据不足时保持未知，不把最终错误、`no available accounts` 或已提交的流式响应归因于模板漏配。
  - 数据口径：
    - `/models`、billing、failover 中间事件和其他非最终用户可见记录不作为模板匹配或评分输入；
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
  - TTFT 样本不足时，`L` 使用 YAML `ttftPriorScore`，完整保留延迟权重与分母；输出 `latencyEvidence=prior`，不得因缺失 TTFT 虚高；
  - 优先级计划对已观测的 `ttftP95Ms` 单独采用线性负向扣分：按对应评分策略配置的
    `ttftFullScoreMs` 至 `ttftZeroScoreMs` 绝对边界计算，低于最低边界扣 `0` 分，
    高于最高边界扣 `100` 分，中间值按比例扣分；不让单个异常慢账号改变整批基准；
    缺少可信 TTFT 集合时回退全部可用 TTFT 样本；
  - 该扣分输出为 `latencyPenalty`，并通过 `latencyWeight` 作用于综合排序；缺少
    TTFT 时保留原有延迟 prior，不将缺失样本误判为低延迟；
  - 切号分别输出 `recoveredFailoverRate`、`unrecoveredFailoverRate` 和 `effectiveFailoverRate`；有效率为 `未恢复 + 0.25 × 已恢复`，再线性计入切号分。
- `E` 是独立证据分：请求样本量占 `50%`、首 Token 样本量占 `25%`、首 Token 覆盖率占 `25%`；只影响连续排序，不做可调度硬过滤。
- 优先使用探测成本；探测成本缺失时再使用手工成本。
- 成本维度采用扣分制：以本轮可调度账号的实际人民币成本范围做线性归一化，最低成本扣 `0` 分，最高成本扣 `100` 分，中间成本按比例扣分；`costWeight` 是扣分幅度，不使用负权重。
- 成本范围的锚点优先取当前可调度、具有成本数据且满足 `requiredConfidence` 的账号；没有该证据集时才回退所有当前可调度账号，输出 `costNormalizationRange.evidenceSource` 与 `evidenceCount`。
- 成本范围不再使用 P10/P90 截断，避免 `0.15` 与 `0.2` 等不同成本被同时压成 `costScore=0`；高成本账号仍可因质量和延迟保持可调度，但不会因成本维度获得奖励。
- 成本采样口径：
  - 供应商 API-USD 产出分母使用 Sub2API `usage_logs.total_cost`，即标准 API 成本；
  - 不得使用 `actual_cost` 作为供应商产出分母，该字段是用户/API Key 实际扣费，包含下游计费倍率；
  - `effective_rate_multiplier` 是认证 API Key 的有效计费倍率，不是人民币汇率；人民币金额必须另乘共享钱包的 `CNY/API-USD` 换算率；
  - 钱包换算率缺少可信证据时必须保留 warning/未知状态，不得把用户扣费倍率或未经确认的倍率静默当作人民币换算率。
- 池级质量的数据完整度：
  - `scores pool-quality` 统计最近窗口内用户可见错误的账号归属总数、已归属数、未归属数和完整率；
  - 未归属错误只说明运行面归因数据不完整，禁止推断或扣分到任何单一账号；
  - 该指标不参与账号优先级计算，只用于核查错误归因与观测质量。
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
- 自动调整每轮有界超时，失败后跳过本轮并从结束时间计算下一轮。
- 任何真实写操作先展示计划，再显式确认并回读验证。
- 单个请求的切号判定优先使用 `errors inspect --request-id <request-id> --over-api`；该入口并行取得诊断链和请求详情。需要只看聚合诊断时才使用 `errors diagnose --request-id <request-id> --over-api`，不要用大范围错误列表推断单请求是否命中模板。
- 按模型排障使用 `errors diagnose --model <exact-model-id> --limit <N> --top <N> --over-api`。返回的模型 × 账号 × 链矩阵与样本链均来自已持久化尝试；运行面未记录的候选排除原因必须标记为未知，不能反推。
- 精确诊断中的 `responseEvidence` 只展示限长脱敏摘要；`available=false` 表示运行面没有持久化可读正文，不能把包装层错误文本当作供应商业务原因。
- 模板变更使用 `upstreams template --confirm --over-api`，默认范围为全部 API-key 上游账号，必须以原工作流回读的 `verifiedCount`、`failedCount` 和 `misalignedCount` 收口。
