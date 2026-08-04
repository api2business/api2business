# Runtime 控制规格

- Api2Business 是账号、上游、评分、调度、错误诊断和经营核算的唯一运行控制入口。
- Web、CLI、HTTP API 和 worker 复用同一领域服务，不各自实现 mutation。
- HTTP API 只校验和受理长流程，返回稳定作业 ID；worker 执行长流程。
- 数据库读取经过应用内排队通道，限制连接并保持普通 API 请求可并发。
- 批量操作优先使用上游原生批量接口，终态通过排队读取核对。
- 所有 mutation 必须幂等、可观察，并保留不含 Secret 的有界日志。
- 部署、Secret 注入和公开暴露由 Api2Business 自有配置与部署资产描述。
