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
| 2026-08-01 | tool | `native start --component all` 成功启动 Compose 三组件但 stdout 为空 | 空输出不能作为成功证据；立即用 `native status --component all` 回读三组件，并把 start 可见性作为独立 CLI 缺陷治理 |
| 2026-08-01 | self | New API 日志测试用 `endsWith("/api/log/token")`，未考虑真实请求带查询参数，误判倍率回退失败 | API 测试按 URL pathname 或 `includes` 匹配带查询参数的端点 |
| 2026-08-01 | self | 前端用 `Number(probe.value)` 判断倍率，导致 `null` 被显示成零成本 | 数值探测先显式排除 `null`，且成本倍率只接受有限正数 |
| 2026-08-02 | runtime | 尝试给 OpenAI OAuth 写入 API-key 的 `pool_mode` 和 `temp_unschedulable_*` 字段，更新接口返回成功但数据库回读字段不存在 | 当前 Sub2API 临时不可调度模板仅支持 API-key；OAuth 必须先由 Sub2API 后端扩展凭据 schema 和调度读取逻辑，不能把 PUT 成功当作已套用 |
| 2026-08-02 | self | 用 `bun --check static/app.js` 做浏览器脚本语法检查时，Bun 实际执行模块并因缺少 `document` 报错 | 浏览器脚本使用 `node --check` 或现有静态测试做纯语法验证，不能把 Bun 顶层执行错误误判为前端语法错误 |
| 2026-08-02 | runtime | Compose 分组件重建后立即并行回读时，一次请求仍命中切换窗口内的旧 API 响应 | L1 重载后先确认组件状态，再串行复读关键字段；只有连续新响应才能作为部署验收证据 |
| 2026-08-02 | self | 导入 options 新增 OAuth 初始预期投影后，旧 service 测试夹具没有完整 `oauthEconomics` 而失败 | YAML-first 配置新增消费字段时补齐测试夹具并断言投影；不要在生产代码增加静默默认值 |
| 2026-08-02 | runtime | L1 API 容器不直接暴露 host `15172`，Web 同源 `/api` 匿名访问返回 401 | L1 页面资源从 `15173` 回读；受保护 API 用正式认证入口或 service 测试验证，不把未暴露端口/匿名 401 当作服务故障 |
| 2026-08-02 | runtime | 周期采样只捕获 activity 错误，但复用 10 分钟执行超时且失败后再 sleep 完整周期，导致 5 分钟采样长期停滞 | 周期 activity 同时设置小于周期的 `scheduleToClose`/`startToClose`，单轮不重试；失败后只等待周期剩余时间，并用版本化 workflow 迁移旧参数 |
| 2026-08-02 | self | 合并评分与上游管理页时删除旧评分摘要 DOM，却保留 `renderScoreMetrics()` 的无条件节点写入，L1 出现 `Cannot set properties of null` | 页面结构收敛后同步清理旧 renderer 依赖；可选投影必须先检查节点存在，并用真实 L1 fatal banner 验收 |
| 2026-08-02 | tool | ApiState product-smoke 只等待 `tbody tr`，初始空态占位行使 scores 步骤以 `rowCount=1` 提前通过 | 统一页验收不能只看 rowCount；必须同时断言无 fatal banner、空态消失、数据行标识和已加载状态 |
| 2026-08-02 | self | 上游创建流程只更新运行参数，页面却提示会自动套切号模板 | 创建成功前显式调用 `applyTemplate([accountId])` 并要求排队回读 verified；模板失败必须返回 partial 状态 |
| 2026-08-02 | self | 修改切号规则后直接用 L1 诊断结果判断新分类已生效 | 主工作区存在并行未提交改动时，L0 通过不等于 L1 生效；必须先完成固定工作区收口并重载 Worker，再用 `errors diagnose` 回读新 stablePhrase |
| 2026-08-02 | user | 把 `404 model_not_found` 加入切号模板，会让请求不存在模型的用户依次打穿全池并临时摘除所有账号 | 404 属于模型/路由能力错误，一律直接返回标准错误；切号模板不得配置任何 `errorCode: 404` 规则 |
| 2026-08-03 | runtime | Sub2API 排队读取只在 SQL 开始后设置 `statement_timeout`，连接获取或事务建立卡住时会永久占用唯一读槽 | 整个事务外层必须有 watchdog；超时清空 active 状态并回收生产连接，下一条任务继续执行 |
| 2026-08-03 | self | 明知项目规则禁止裸 `tsc`，仍在并行检查中调用了 `bunx tsc --noEmit`，且误用了不存在的 `build` 脚本 | 先读取 `package.json`，只使用项目声明的受控检查入口；ApiState 使用 `bun run check`，不猜测脚本名 |
| 2026-08-03 | tool | ApiState `native start/stop --component all --json` 成功执行时仍可能完全无输出 | 无输出一律不作成功证据，立即用 `native status --component all --json` 回读；生命周期 CLI 可见性需独立修复 |
| 2026-08-03 | self | 给批量导入增加专用 timeout 时一度在 `mutate()` 内直接 fetch，绕过了统一认证头注入 | 传输选项必须沿 `request()` 统一路径透传，不能复制请求实现 |
| 2026-08-03 | runtime | Sub2API 原生账号测试 API 返回独立管理测试结果，但不会写入普通 `usage_logs`、`ops_error_logs` 或 failover 链 | ApiState 必须标注 `admin-account-test-response` 且声明 `ordinaryLogRecorded: false`；在官方测试链复用普通日志前保持自动探活关闭，不伪造评分样本 |
| 2026-08-03 | user | 探活隔离分组若公开或用上游 URL 命名，会泄露供应商信息并允许其他用户选到该组 | 每账号使用 `is_exclusive=true` 的私有组，名称固定为 `apistate-probe-<accountId>`，只绑定目标账号和专用 Key；不得出现上游 URL、域名或费率 |
| 2026-08-03 | self | 为核对 Compose 挂载误用 `docker inspect .Config.Env`，导致诊断输出包含运行面 Secret | 容器诊断只查询 `WorkingDir`、`Mounts`、状态和脱敏路径；禁止输出完整 `.Config.Env`，环境字段只经受控状态接口核对 presence/fingerprint |
| 2026-08-03 | runtime | 探活工作流超时后被误判为普通网关请求超时，但 Secret 未落盘且账号未绑定隔离组，实际失败发生在隔离初始化阶段 | 隔离初始化按分组、专用凭据、账号绑定和 Secret 持久化分阶段返回脱敏错误；只有收到网关 HTTP 响应才能将普通日志标记为已记录候选 |
| 2026-08-03 | self | ApiState `web-probe product-smoke` 误把页面内的 PK01 后端标签当成 Web target，并误用通用 profile | ApiState Web 使用 owning target `NC01`；上游资产页使用 profile `scores`，PK01 只表示 Sub2API 后端目标 |

## User Preferences
- 调度算法变更先手动生成并确认一次真实优先级调整，排队回读成功后再启用或调整自动调优周期。
- 账号评分与 API-key 上游管理使用同一运营页：顶部先展示上游资产与实时成本，其次是默认按评分排序且支持表头排序的总表，最后展示调整记录。
- 用户用量管理页直接展示完整邮箱，不使用后端脱敏或前端省略；公共抽奖与公开记录仍保持身份脱敏。
- 运营页桌面布局要压缩无效留白；标题、切换和刷新控件应共用顶部控制带，图表应铺满分栏可用绘图区。
- 非 OAuth 上游先按账号评分排序，再把排序归一化到优先级 100 至 300。
- OAuth 不参与自动调优：快刷账号可人工设为小于 100，兜底账号可人工设为大于 300。
- 局部排序变化应尽量只影响局部优先级，避免全池频繁写入。
- 调度目标只通过质量、成本、探索和余额权重实现，不为单个账号增加门槛、固定名次或特判。

## Patterns That Work
- ApiState L1 运行与验收使用项目 CLI 和 `--over-api`，不裸调运行组件。
- Sub2API 原生 OAuth 批量导入使用独立 120 秒 timeout；transport timeout 后先走同一 preflight 对账，按原始匹配区分新建与更新，禁止盲重试或重复记账。
- 大批量 runtime 删除即使 CLI 因输出预算返回失败，也必须通过 ApiState 排队数据库回读判断真实终态。
- OAuth 与上游历史曲线使用同一个配置式 SVG 组件；单位格式化、共享纵轴、刻度和图例由调用配置提供，页面不再手写重复图例。
- 评分页刷新必须让评分、资产、额度和质量独立请求、独立防重入并保留旧投影；额度摘要不能等待账号分页或缓存批次后才渲染。

## Patterns That Don't Work
- 不在 TaskTree 的 `/workspace/unidesk` 工作目录中顺带执行 ApiState 源码命令。

## Domain Notes
- Sub2API 优先级数字越小，调度越靠前。
- Sub2API `/v1/usage` 的 `mode=unrestricted` 只表示 API Key 不受 quota/rate-limit；只有顶层 `remaining`/`balance` 或 `subscription`/`usage.total` 才是可展示的额度与用量数据，空 mode 响应必须继续探测其他协议并报不支持。
- Sub2API 的 API Key 可通过 `/v1/sub2api/billing` 获取当前有效倍率；New API 没有等价实时接口，只能把 `/api/log/token` 的 `user_group_ratio`/`group_ratio` 作为最近消费观测值，不能用 `/api/pricing` 合成当前 Key 倍率。
