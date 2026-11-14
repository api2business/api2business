const entry = "bun skills/api2business/scripts/api2business-cli.ts";

const configOption = "可选；Api2Business 仓库根自动读取 config/api2business.yaml，其他 cwd 必须显式传入 owning YAML；查看帮助不加载配置";
const overApiOption = "实际查询或写入必填；owning YAML 声明的绝对 HTTP(S) URL，不接受别名、布尔开关或隐式目标";
const scopeOption = "可选；限定 codex、claude、grok 或 deepseek；生产排查应显式传入，避免把默认作用域当成所问作用域";
const jsonOption = "输出结构化回执，便于 jq 只投影必要字段";

export function priorityHistoryHelp(): Record<string, unknown> {
  return {
    ok: true,
    command: "priority history",
    usage: `${entry} --config <owning-YAML> priority history --over-api <absolute-http(s)-URL> [--scope codex|claude|grok|deepseek|opencode] [--account <positive-id>] [--json]`,
    options: {
      "--config": "实际查询使用的 owning YAML；查看帮助不加载配置",
      "--over-api": "实际查询必填；owning YAML 声明的绝对 HTTP(S) URL，不接受别名或布尔开关",
      "--scope": "可选；只保留 profile 或 profiles 含该作用域的轮次。取值 codex、claude、grok、deepseek、opencode",
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

const idleProbeActions = ["plan", "history", "coverage", "reconcile", "run"] as const;

export function idleProbeHelp(action?: string): Record<string, unknown> {
  const selected = action && idleProbeActions.includes(action as typeof idleProbeActions[number]) ? action : null;
  if (action && !selected && action !== "--help") throw new Error(`unknown accounts idle-probe action ${action}`);
  const usageSuffix = selected === "history"
    ? "[--scope codex|claude|grok|deepseek] [--page N]"
    : selected === "coverage"
      ? "[--scope codex|claude|grok|deepseek] [--window-minutes N]"
      : selected === "reconcile"
        ? "[--accounts <id-or-range,...>] [--scope codex|claude|grok|deepseek] [--confirm]"
        : selected === "run"
          ? "[--accounts <id-or-range,...>] [--scope codex|claude|grok|deepseek] [--rounds 1..10] [--confirm]"
          : selected === "plan"
            ? "[--accounts <id-or-range,...>] [--scope codex|claude|grok|deepseek]"
            : "plan|history|coverage|reconcile|run [options]";
  const options: Record<string, string> = {
    "--config": configOption,
    "--over-api": overApiOption,
    "--scope": scopeOption,
    "--json": jsonOption,
  };
  if (selected === "plan" || selected === "reconcile" || selected === "run" || selected === null) {
    options["--accounts"] = "可选；正整数账号 ID、逗号列表或范围；省略表示该作用域全部候选账号";
  }
  if (selected === "history" || selected === null) options["--page"] = "可选；正整数页码，省略为 1";
  if (selected === "coverage" || selected === null) options["--window-minutes"] = "可选；正整数覆盖窗口，省略为 20 分钟；生产核对同时查看 24 小时窗口";
  if (selected === "run" || selected === null) options["--rounds"] = "可选；1 到 10 的整数，省略为 1";
  if (selected === "reconcile" || selected === "run" || selected === null) options["--confirm"] = "写入确认；省略时只返回预览并设置 mutation=false";
  const usageAction = selected ?? "plan|history|coverage|reconcile|run";
  const usageTail = selected ? usageSuffix : "[options]";
  return {
    ok: true,
    command: `accounts idle-probe${selected ? ` ${selected}` : ""}`,
    usage: `${entry} --config <owning-YAML> accounts idle-probe ${usageAction} ${usageTail} --over-api <absolute-http(s)-URL> [--json]`,
    options,
    behavior: selected === "plan"
      ? "只读计算同作用域待探活计划，不创建隔离 Key、不发送探活请求。"
      : selected === "history"
        ? "只读读取持久化探活轮次；省略 scope 时不能把混合轮次归属到某个平台。"
        : selected === "coverage"
          ? "只读统计同作用域专用 Key 的覆盖记录；短窗口缺失不等于账号永久无样本。"
          : selected === "reconcile"
            ? "默认只读预览；--confirm 仅补齐缺失的探活隔离绑定，不发送探活请求、不改账号状态。"
            : selected === "run"
              ? "默认只读预览；--confirm 提交异步探活轮次，只执行 active、schedulable、已就绪且非 in-flight 的账号。"
              : "plan、history、coverage 只读；reconcile 和 run 默认预览，只有 --confirm 才写入。",
    verification: selected === "reconcile"
      ? "先核对预览中的缺失绑定，再确认执行；回读同作用域 coverage、账号隔离分组和 workflow 终态。"
      : selected === "run"
        ? "用 workflow status --id <workflow-id> 追踪真实终态，再回读 idle-probe history 与 coverage；作业创建成功不等于探活完成。"
        : "以同作用域 workspace 的 plan、history、coverage 和真实账号范围交叉核对，不用其他作用域或旧全局标签推断。",
  };
}

const schedulingActions = ["scopes", "snapshot", "plan", "priority-run", "model-sync"] as const;

export function upstreamSchedulingV2Help(action?: string, subaction?: string): Record<string, unknown> {
  const selected = action && schedulingActions.includes(action as typeof schedulingActions[number]) ? action : null;
  if (action && !selected && action !== "--help") throw new Error(`unknown upstream-scheduling-v2 action ${action}`);
  const modelSyncAction = selected === "model-sync" && subaction && ["plan", "run", "history"].includes(subaction)
    ? subaction
    : null;
  const path = selected === "model-sync"
    ? `model-sync ${modelSyncAction ?? "plan|run|history"}`
    : selected ?? "scopes|snapshot|plan|priority-run|model-sync";
  const options: Record<string, string> = {
    "--config": configOption,
    "--over-api": overApiOption,
    "--scope": scopeOption,
    "--json": jsonOption,
  };
  if (selected === "snapshot") {
    options["--refresh"] = "同步等待一次读模型重建；不得与 --cache-only 同时使用";
    options["--cache-only"] = "只读取最近成功缓存，不触发刷新；用于刷新失败后的单次兜底";
  }
  if (selected === "priority-run") options["--confirm"] = "执行确认；省略时只返回预览并设置 mutation=false";
  if (selected === "model-sync") {
    options["--accounts"] = "可选；正整数账号 ID、逗号列表或范围，省略表示该作用域全部候选账号";
    if (!modelSyncAction || modelSyncAction === "run") options["--confirm"] = "执行确认；省略时只返回预览并设置 mutation=false";
    if (!modelSyncAction || modelSyncAction === "history") options["--page"] = "可选；正整数页码，省略为 1";
  }
  const usage = selected === "priority-run"
    ? `${entry} --config <owning-YAML> upstream-scheduling-v2 priority-run --scope codex|claude|grok|deepseek [--confirm] --over-api <absolute-http(s)-URL> [--json]`
    : selected === "snapshot"
      ? `${entry} --config <owning-YAML> upstream-scheduling-v2 snapshot [--scope codex|claude|grok|deepseek] [--refresh|--cache-only] --over-api <absolute-http(s)-URL> [--json]`
      : selected === "model-sync"
        ? `${entry} --config <owning-YAML> upstream-scheduling-v2 model-sync ${modelSyncAction ?? "plan|run|history"} [--scope codex|claude|grok|deepseek] [--accounts <id-or-range,...>]${!modelSyncAction || modelSyncAction === "run" ? " [--confirm]" : ""}${!modelSyncAction || modelSyncAction === "history" ? " [--page N]" : ""} --over-api <absolute-http(s)-URL> [--json]`
        : `${entry} --config <owning-YAML> upstream-scheduling-v2 ${path} [--scope codex|claude|grok|deepseek] --over-api <absolute-http(s)-URL> [--json]`;
  return {
    ok: true,
    command: `upstream-scheduling-v2 ${path}`,
    usage,
    options,
    behavior: selected === "snapshot"
      ? "默认读取缓存并由服务后台刷新；--refresh 同步等待重建；--cache-only 只读最近成功缓存。三者均为只读，不修改调度配置。"
      : selected === "priority-run"
        ? "默认只读预览；--confirm 通过原生 worker 执行一次指定作用域的优先级调整，不直接连接业务库。"
        : selected === "model-sync"
          ? "plan 与 history 只读；run 默认预览，--confirm 后执行模型同步，并用 workflow 与原生账号回读核验。"
          : "scopes 与 plan 只读；其他动作按各自 usage 执行，不把页面存在或请求成功当作业务终态。",
    verification: selected === "snapshot"
      ? "同时核对 cache.state、cache.complete、capturedAt、cache.sections、failedSections 与 lastCompleteAt；state=stale 且 complete=true 不等于刷新失败。"
      : selected === "priority-run"
        ? "回读 priority history --scope <scope>、snapshot 和 plan，核对真实变更数、查询耗时、score_error 与阻断原因；applied 只表示执行过。"
        : "以同一绝对 URL 的 workflow 终态、同作用域 snapshot/plan 和原生账号回读交叉核验，不跨作用域推断。",
  };
}

export function scoreRankHelp(): Record<string, unknown> {
  return {
    ok: true,
    command: "scores rank",
    usage: `${entry} --config <owning-YAML> scores rank [--calls N] [--account <id-or-name>] [--group <id-or-exact-name>] --over-api <absolute-http(s)-URL> [--json]`,
    options: {
      "--config": configOption,
      "--over-api": overApiOption,
      "--calls": "可选；非负整数，覆盖本窗口最近调用样本上限；省略时读取 owning YAML 的 monitor.recentCallLimit",
      "--account": "可选；只读取一个账号，接受正整数 ID 或精确账号名",
      "--group": "可选；只读取一个业务分组，接受正整数 ID 或精确分组名",
      "--json": jsonOption,
    },
    behavior: "读取当前账号评分与真实刷新结果；不会把已有旧缓存当成本次查询成功。",
    verification: "核对 refreshedAt 是否前进、queryDurationMs、账号数，以及窗口失败率、突发失败率和有效失败率；单账号变化再用 priority history --account 回读。",
  };
}

export function operationHelp(args: string[]): Record<string, unknown> | null {
  const position = (first: string, second?: string): number => args.findIndex((item, index) => item === first && (second === undefined || args[index + 1] === second));
  const actionAfter = (start: number, actions: readonly string[]): string | undefined => args.slice(start + 1).find((item) => actions.includes(item));
  const idleProbe = position("accounts", "idle-probe");
  if (idleProbe >= 0) return idleProbeHelp(actionAfter(idleProbe + 1, idleProbeActions));
  const scheduling = args.indexOf("upstream-scheduling-v2");
  if (scheduling >= 0) {
    const action = actionAfter(scheduling, schedulingActions);
    const modelSync = action === "model-sync" ? args.indexOf("model-sync") : -1;
    return upstreamSchedulingV2Help(action, action === "model-sync"
      ? actionAfter(modelSync, ["plan", "run", "history"])
      : undefined);
  }
  const scores = position("scores", "rank");
  if (scores >= 0) return scoreRankHelp();
  return null;
}
