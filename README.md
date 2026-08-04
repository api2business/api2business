# Api2Business

Api2Business 提交的配置模板位于 `config/api2business.example.yaml`。本机运行配置不进入
Git，首次使用时复制模板为 `config/api2business.yaml`，再填入当前环境的运行目标、
公开入口和 Secret 引用。

Secret 值不得写入 YAML。凭据通过 `sourceRef` 指向仓库外、仅 owner 可读的文件，
生产配置和经营日报统一保存在 Git 忽略目录中。
