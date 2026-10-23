const entry = "bun skills/api2business/scripts/api2business-cli.ts";

export function priorityHistoryHelp(): Record<string, unknown> {
  return {
    ok: true,
    command: "priority history",
    usage: `${entry} --config <owning-YAML> priority history --over-api <absolute-http(s)-URL> [--scope codex|claude|grok|deepseek] [--account <positive-id>] [--json]`,
    options: {
      "--config": "实际查询使用的 owning YAML；查看帮助不加载配置",
      "--over-api": "实际查询必填；owning YAML 声明的绝对 HTTP(S) URL，不接受别名或布尔开关",
      "--scope": "可选；只保留 profile 或 profiles 含该作用域的轮次。取值 codex、claude、grok、deepseek",
      "--account": "可选；正整数账号 ID。给出后只返回该账号的前后优先级，不返回其他账号或原始 priorities",
      "--json": "展开匹配轮次的完整回执，包括作用域、触发方式、终态及实际变更数",
    },
    behavior: "只读查询原优先级执行历史，不触发评分、优先级调整或上游写入。未给 --account 时人类输出只打印有界轮次摘要，并披露过滤与展示省略数。",
    verification: "applied 只表示该轮执行过。单账号变化以 --account 的 before_priority 与 desired_priority 为准，再独立回读原生账号。",
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
