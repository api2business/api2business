---
name: api2business
description: >-
  Api2Business 开发、配置、部署和运行维护技能。用户要求安装、部署、升级、验证、
  排查 Api2Business，或操作账号、评分、上游、成本和经营核算时使用。
---

# Api2Business

## 工作区

- 从当前 Api2Business 仓库根目录执行命令。
- 使用 `config/api2business.yaml` 保存本地配置；该文件不得提交。
- 使用 `scripts/api2business-cli.ts` 执行业务和生命周期操作。

## 部署

- 先读取 `docs/reference/deployment.md`。
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
bun scripts/api2business-cli.ts --config config/api2business.yaml native start --component all
bun scripts/api2business-cli.ts --config config/api2business.yaml native status --component all
bun scripts/api2business-cli.ts --config config/api2business.yaml native logs --component all --tail 100
bun scripts/api2business-cli.ts --config config/api2business.yaml native stop --component all
```

- `native` 是统一生命周期入口，实际运行方式由配置选择。
- API 应快速返回作业 ID，长流程由 worker 执行。
- 数据库读取使用应用内排队读取通道，不从外部脚本直接连接业务数据库。

## 领域操作

- 账号导入、生命周期和空闲探活读取 `references/account-operations.md`。
- 上游、评分和优先级读取 `references/upstream-scheduling.md`。
- 收入、采购、充值、退款和毛利读取 `references/accounting.md`。

## 验收

- 验证 `/health`、Web 登录、主要数据页和至少一个异步作业。
- 验证重启后账本、缓存、采样和作业状态仍可读取。
- 失败时按配置、Secret、网络、数据库、worker 和外部 API 的顺序定位首个断点。
