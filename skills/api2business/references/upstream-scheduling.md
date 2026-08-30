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
    - `model_not_found` 和 `model not found` 不得写入模板，因为模型不存在不是账号故障。
  - 模型错误：
    - `selected model is at capacity` 表示模型或容量临时异常，可以切号；
    - `404 model_not_found` 不进入模板，直接保留标准模型错误。
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
- 只使用权重调整质量、成本、余额和探索，不增加隐式硬门槛。
- 优先使用探测成本；探测成本缺失时再使用手工成本。
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
- 精确诊断中的 `responseEvidence` 只展示限长脱敏摘要；`available=false` 表示运行面没有持久化可读正文，不能把包装层错误文本当作供应商业务原因。
- 模板变更使用 `upstreams template --confirm --over-api`，默认范围为全部 API-key 上游账号，必须以原工作流回读的 `verifiedCount`、`failedCount` 和 `misalignedCount` 收口。
