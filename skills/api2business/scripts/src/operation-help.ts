const entry = "bun skills/api2business/scripts/api2business-cli.ts";

export function priorityHistoryHelp(): Record<string, unknown> {
  return {
    ok: true,
    command: "priority history",
    usage: `${entry} --config <owning-YAML> priority history --over-api <absolute-http(s)-URL> [--json]`,
    options: {
      "--config": "实际查询使用的 owning YAML；查看帮助不加载配置",
      "--over-api": "实际查询必填；owning YAML 声明的绝对 HTTP(S) URL，不接受别名或布尔开关",
      "--json": "展开完整历史回执，包括作用域、触发方式、终态及实际变更数",
    },
    behavior: "只读查询原优先级执行历史，不触发评分、优先级调整或上游写入；不同作用域按记录的 profile 区分。",
    verification: "applied 表示该轮执行结果；核对原轮次身份与时间，再独立回读原生账号，不以稍后生成的新计划替代该轮证据。",
  };
}

export function nativeHelp(action?: string): Record<string, unknown> {
  const actions = ["start", "stop", "status", "logs"];
  const selected = !action || action.startsWith("-") ? null : action;
  if (selected && !actions.includes(selected)) throw new Error(`unknown native action ${selected}`);
  return {
    ok: true,
    command: `native${selected ? ` ${selected}` : ""}`,
    usage: `${entry} --config <owning-YAML> native ${selected ?? "start|stop|status|logs"} [--component all|api|worker|web]${!selected || selected === "logs" ? " [--tail N]" : ""} [--json]`,
    options: {
      "--config": "必填；实际执行时从 owning YAML 解析唯一实例，不按环境回退",
      "--component": "all、api、worker 或 web；省略时为 all",
      ...(!selected || selected === "logs" ? { "--tail": "日志尾部行数；省略时为 40" } : {}),
      "--json": "输出结构化回执",
    },
    behavior: "生命周期操作只作用于 YAML 选中的实例；Compose 模式 start 构建并启动，status 和 logs 只读。查看帮助不加载配置、不启动服务。",
  };
}

export function historicalBalanceHelp(): Record<string, unknown> {
  return {
    ok: true,
    command: "upstreams usage-cache restore",
    usage: `${entry} --config <owning-YAML> upstreams usage-cache restore --id <account-id> --base-url <https-url> --remaining-usd <USD> --since <original-observed-ISO-time> --confirm --over-api <absolute-http(s)-URL> [--json]`,
    options: {
      "--config": "必填；目标运行面的 owning YAML",
      "--id": "必填；已核实余额对应的账号 ID",
      "--base-url": "必填；该钱包的 HTTPS 地址",
      "--remaining-usd": "必填；已核实的有限美元余额，允许负数和真实零",
      "--since": "必填；不晚于当前的原始观测时间，不能使用回填操作时间冒充新鲜余额",
      "--confirm": "必填；确认恢复已核实的历史成功值",
      "--over-api": "必填；owning YAML 声明的绝对 HTTP(S) URL，不接受别名或布尔开关",
      "--json": "输出结构化回执",
    },
    behavior: "仅恢复历史成功缓存，不探测供应商、不充值、不改写实际钱包余额；查看帮助不加载配置或执行写入。",
  };
}
