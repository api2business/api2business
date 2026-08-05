---
name: api2business
description: >-
  Api2Business 开发、配置、部署和运行维护技能。用户要求安装、部署、升级、验证、
  排查 Api2Business，或操作账号、评分、上游、成本和经营核算时使用。
---

# Api2Business

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
- 上游、评分和优先级读取 `references/upstream-scheduling.md`。
- 收入、采购、充值、退款和毛利读取 `references/accounting.md`。
- 页面数据快照统一写入 host PostgreSQL：
  - API 与 Worker 按稳定快照键共享成功载荷；
  - 快照型 API 不再叠加通用 HTTP 响应缓存；
  - 成功后原子替换，失败保留上一份成功快照；
  - 账号评分默认每 5 分钟刷新，并在进程重启后优先回显持久化快照。
- 上游智商评测：
  - 提交：`upstreams benchmark --id <account-id> --model <model> --confirm --over-api`；
  - 进度与日志：`upstreams benchmark-status --id <benchmark-run-id> --over-api`；
  - 账号历史：`upstreams benchmark-history --id <account-id> --limit 20 --over-api`；
  - 评测只复用持久化探活专用 API Key，不读取供应商原始 Key，也不轮换探活 Key。

## 验收

- 验证 `/health`、Web 登录、主要数据页和至少一个异步作业。
- 验证重启后账本、缓存、采样和作业状态仍可读取。
- 失败时按配置、Secret、网络、数据库、worker 和外部 API 的顺序定位首个断点。
