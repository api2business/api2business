# 部署参考

## 标准入口

- 所有新环境先克隆 Api2Business 仓库，不从压缩包、运行容器或其他项目复制部署文件。
- 克隆完成后进入仓库根目录，加载仓内 `skills/api2business/SKILL.md`。
- 后续环境识别、配置准备、部署方式选择、执行、验证和回滚均由该 skill 指引。
- 本 reference 只定义稳定部署合同，不替代 skill 的操作流程。

```bash
git clone https://github.com/api2business/api2business.git
cd api2business
```

## 原则

- 部署方式由运行环境决定，不绑定特定 CI、云厂商或编排器。
- 源码提交、镜像摘要、配置摘要和运行版本必须可追溯。
- Secret 只通过环境变量、Secret 挂载或外部 Secret 管理器注入。
- 日志、构建输出、清单和状态接口不得输出 Secret 值。
- API、worker 和 Web 必须使用同一版本的源码与配置。
- 主机运行面的 Temporal 地址由 `runtime.native.temporalAddress` 显式配置。
  - 生命周期入口不查询 Kubernetes，也不保留旧 Service 查询配置。
  - 地址变更时先用原生命令核验目标，再更新主机连接配置。

## 方式选择

- 单机或小规模运行可使用 `compose.yaml`。
- Kubernetes 可从 `deploy/kubernetes/manifest.yaml` 渲染环境清单。
- systemd、Nomad、托管容器或其他平台可直接使用 `Dockerfile` 产出的镜像。
- CI/CD 可以使用任意实现，但应保留构建、发布、上线验证三个独立阶段。

## 通用流程

1. 从受信任的源码提交构建不可变镜像。
2. 从 `config/api2business.example.yaml` 派生环境配置。
3. 在仓库外准备 Secret，并以只读方式注入。
4. 部署 API、worker 和 Web，保持版本一致。
5. 检查 API 健康端点、worker 健康状态和 Web 登录。
6. 记录源码提交、镜像摘要、配置摘要和部署时间。
7. 回滚时恢复上一组镜像摘要与配置摘要，不从运行容器反解配置。

## Compose

```bash
docker compose build
docker compose up -d
docker compose ps
```

- 使用 `API2BUSINESS_CONFIG_PATH` 选择配置。
- 使用 `API2BUSINESS_STATE_ROOT` 指定持久化状态目录。
  - 未设置时 Compose 默认挂载 `/var/lib/api2business`。
- `native start` 从当前工作区构建镜像。
  - 工作区有未提交页面或模板时，不要用它发布。
  - 从已提交树构建镜像，再用 `--no-build` 替换对应服务。
- 使用 `API2BUSINESS_SECRET_ROOT` 指定仓库外 Secret 目录。
- 使用 `API2BUSINESS_INTEGRATION_ROOT` 挂载可选的外部集成文件。
- Compose Web 只允许按 owning 配置绑定 `127.0.0.1`；不得用 `--host 0.0.0.0` 覆盖。
  - 公开业务只经 `api2business.hwpod.com` 的 Caddy/TLS 入口，上游端口必须做旁路核验。
  - HTTPS 生产目标的 `secureCookies` 必须为 `true`；本地 native HTTP 调试可单独关闭。

## Kubernetes

- 将模板占位符替换为镜像摘要、源码提交、配置摘要和 Base64 配置正文。
- 生产环境应根据存储、入口、网络策略和资源预算补充环境 overlay。
- `api2business-secrets` 只声明所需 key，不在 Git 中保存值。

## 验证

```bash
bun run deploy:validate
curl -fsS https://<host>/health
bun run deploy:verify -- --base-url https://<host> --snapshot-json <snapshot.json>
```

- 首次发布还应验证登录、主要数据页、异步 worker 作业和持久化缓存。
- 每次原生发布后必须运行 `deploy:verify`。
  - 页面必须包含“探活缓存命中”摘要卡，且 `app.js`、页面模块和 HTML 使用同一个前端 revision。
  - 提供的 snapshot 必须是 `cache.state=hit|stale|refreshed`、`cache.complete=true`，并包含 `data.probeHistory.cacheSummary`。
  - 发布校验失败时，先比对镜像、提交和前端 revision；不得用浏览器刷新或手改文案掩盖旧 bundle。
- 验证失败时保留旧版本服务，先定位源码、镜像、配置、Secret 或网络中的首个断点。
