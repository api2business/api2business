import { AdminHttpClient } from "../../src/admin-http-client";
import { readFileSync } from "node:fs";
import { mergeAccountScores } from "../../src/account-score-aggregation";
import { createEmbeddedContext } from "../../src/bootstrap";
import { loadConfig, type EmbeddedCliTarget, type HttpCliTarget, type NativeServiceId } from "../../src/config";
import type { AppCommand } from "../../src/contracts";
import { usesWorkflow } from "../../src/contracts";
import { ApplicationDispatcher } from "../../src/dispatcher";
import { nativeAll, nativeLogs, nativeStart, nativeStatus, nativeStop } from "../../src/native-services";
import { TemporalGateway } from "../../src/temporal-client";
import { emitUserImpact } from "./user-impact-output";
import { emitErrorAggregate } from "./error-aggregate-output";
import { emitErrorDiagnosis } from "./error-diagnose-output";
import { emitPriorityPlan } from "./priority-plan-output";
import { emitAccountEconomics, emitAccountImportEconomics } from "./account-economics-output";
import { emitOAuthEconomics } from "./oauth-economics-output";
import { emitDailyProfit } from "./daily-profit-output";
import { parseAccountIdSelector } from "../../src/account-batch-economics";
import { runBoundedProcess } from "../../src/bounded-process";

type Row = Record<string, unknown>;

interface Parsed {
  configPath: string;
  targetId: string | null;
  command: string[];
  confirm: boolean;
  includeRecords: boolean;
  overApi: boolean;
  json: boolean;
  id: string | null;
  requestId: string | null;
  component: NativeServiceId | "all" | null;
  limit: number | null;
  draws: number | null;
  tail: number | null;
  top: number | null;
  calls: number | null;
  account: string | null;
  group: string | null;
  start: string | null;
  end: string | null;
  affectedOnly: boolean;
  intervalSeconds: number | null;
  enabled: boolean | null;
  file: string | null;
  priority: number | null;
  capacity: number | null;
  groups: string | null;
  proxyId: number | null;
  accounts: string | null;
  costCny: number | null;
  unitCostCny: number | null;
  planType: string | null;
  scope: string | null;
  profile: string | null;
  model: string | null;
  day: string | null;
  period: string | null;
  externalCostsJson: string | null;
  baseUrl: string | null;
  suffix: string | null;
  rate: number | null;
  rechargeCny: number | null;
  page: number | null;
  search: string | null;
  apiKeyStdin: boolean;
  templateOnly: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function value(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const result = args[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
  return result;
}

function parseArgs(args: string[]): Parsed {
  const configPath = value(args, "--config");
  if (!configPath) throw new Error("--config is required");
  const optionNames = new Set(["--config", "--target", "--id", "--request-id", "--limit", "--top", "--draws", "--component", "--tail", "--calls", "--account", "--accounts", "--group", "--start", "--end", "--day", "--period", "--cost-cny", "--unit-cost-cny", "--plan-type", "--scope", "--profile", "--model", "--interval-seconds", "--enabled", "--file", "--priority", "--capacity", "--groups", "--proxy-id", "--external-costs-json", "--base-url", "--suffix", "--rate", "--recharge-cny", "--page", "--search"]);
  const flags = new Set(["--confirm", "--include-records", "--over-api", "--json", "--affected-only", "--api-key-stdin", "--template-only"]);
  const command: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]!;
    if (optionNames.has(item)) { index += 1; continue; }
    if (flags.has(item)) continue;
    if (item.startsWith("--")) throw new Error(`unknown option ${item}`);
    command.push(item);
  }
  const integer = (name: string): number | null => {
    const raw = value(args, name);
    if (raw === null) return null;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
    return parsed;
  };
  const component = value(args, "--component");
  if (component !== null && component !== "all" && component !== "api" && component !== "worker" && component !== "web") throw new Error("--component must be all, api, worker, or web");
  const decimal = (name: string): number | null => {
    const raw = value(args, name);
    if (raw === null) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
    return parsed;
  };
  return {
    configPath,
    targetId: value(args, "--target"),
    command,
    confirm: args.includes("--confirm"),
    includeRecords: args.includes("--include-records"),
    overApi: args.includes("--over-api"),
    json: args.includes("--json"),
    id: value(args, "--id"),
    requestId: value(args, "--request-id"),
    component,
    limit: integer("--limit"),
    draws: integer("--draws"),
    tail: integer("--tail"),
    top: integer("--top"),
    calls: integer("--calls"),
    account: value(args, "--account"),
    accounts: value(args, "--accounts"),
    group: value(args, "--group"),
    start: value(args, "--start"),
    end: value(args, "--end"),
    day: value(args, "--day"),
    period: value(args, "--period"),
    costCny: decimal("--cost-cny"),
    unitCostCny: decimal("--unit-cost-cny"),
    planType: value(args, "--plan-type"),
    scope: value(args, "--scope"),
    profile: value(args, "--profile"),
    model: value(args, "--model"),
    affectedOnly: args.includes("--affected-only"),
    intervalSeconds: integer("--interval-seconds"),
    enabled: value(args, "--enabled") === null ? null
      : value(args, "--enabled") === "true" ? true
      : value(args, "--enabled") === "false" ? false
      : (() => { throw new Error("--enabled must be true or false"); })(),
    file: value(args, "--file"), priority: integer("--priority"), capacity: integer("--capacity"),
    groups: value(args, "--groups"), proxyId: integer("--proxy-id"),
    externalCostsJson: value(args, "--external-costs-json"),
    baseUrl: value(args, "--base-url"), suffix: value(args, "--suffix"),
    rate: decimal("--rate"), rechargeCny: decimal("--recharge-cny"),
    page: integer("--page"), search: value(args, "--search"), apiKeyStdin: args.includes("--api-key-stdin"),
    templateOnly: args.includes("--template-only"),
  };
}

function help(): Record<string, unknown> {
  return {
    ok: true,
    usage: "bun scripts/apistate-cli.ts --config config/sub2rank.yaml [--over-api] [--target <id>] <command>",
    commands: [
      "config validate",
      "backend check",
      "scores get|refresh|rank|priority-plan [--calls N] [--account <id-or-name>] [--group <id-or-exact-name>]|aggregate-smoke",
      "reads status",
      "errors aggregate [--limit N] [--top N] [--account <id-or-name>] [--group <id-or-exact-name>]",
      "errors diagnose [--limit N] [--top N] [--account <id-or-name>] [--group <id-or-exact-name>]",
      "errors list [--limit N]",
      "errors get --request-id <request-id>",
      "users impact --start <ISO> --end <ISO> [--affected-only]",
      "users balance-liability [--over-api]",
      "profit daily-facts --day YYYY-MM-DD [--over-api]",
      "profit daily [--day YYYY-MM-DD] [--over-api] (default: today in configured timezone)",
      "lottery status|draw|reset",
      "records list|delete",
      "credit test",
      "api smoke --over-api",
      "workflow status --id <workflow-id>",
      "priority automation get|create|update|delete --over-api [--interval-seconds N --calls N --enabled true|false] [--confirm]",
      "priority plan create --over-api [--calls N]",
      "priority plan confirm --over-api --id ID --confirm",
      "priority history --over-api",
      "accounts import --file <json|zip> --unit-cost-cny <CNY> [--plan-type k12|plus|team|free] [--priority 1 --capacity 16 --groups 2,3 --proxy-id 3] [--confirm] --over-api",
      "accounts status --id <job-id> --over-api",
      "accounts inspect --accounts <id-or-range,...> [--over-api]",
      "accounts delete --accounts <id-or-range,...> [--confirm] --over-api",
      "accounts economics --accounts <id-or-range,...> --cost-cny <amount> (--day YYYY-MM-DD | --start <ISO> --end <ISO>) [--over-api]",
      "accounts import-economics --day YYYY-MM-DD [--external-costs-json <json>] [--over-api]",
      "accounts oauth-economics [--profile codex|grok] [--over-api]",
      "accounts lifecycle detect --day YYYY-MM-DD --plan-type k12|plus [--model <id>] [--confirm] --over-api",
      "accounts lifecycle retire plan [--day YYYY-MM-DD] [--scope pool|day] --over-api",
      "accounts lifecycle retire status --id <plan-id> --over-api",
      "accounts lifecycle retire confirm --id <plan-id> --confirm --over-api",
      "upstreams list [--page N --search <text>] --over-api",
      "upstreams usage [--accounts <id-or-range,...>] --over-api",
      "upstreams template [--accounts <id-or-range,...>] [--confirm] --over-api",
      "upstreams create --base-url <https-url> --suffix <name> --rate <CNY/API_USD> [--priority 1 --capacity 16 --groups 2,3 --recharge-cny CNY] --api-key-stdin [--confirm] --over-api",
      "upstreams update --id <account-id> [--suffix <name>] [--rate <CNY/API_USD>] [--template-only] [--confirm] --over-api",
      "upstreams status --id <workflow-id> --over-api",
      "payments alipay-revenue (--day YYYY-MM-DD | --period YYYY-MM) [--over-api]",
      "native start|stop|status|logs [--component all|api|worker|web] [--tail N]",
    ],
    output: "k8s-style text by default; add --json for machine output",
  };
}

function emitScoreRanking(value: Record<string, unknown>, json: boolean): void {
  if (json) return emit(value, true);
  const accounts = Array.isArray(value.accounts) ? value.accounts.map(record).filter((row): row is Record<string, unknown> => row !== null) : [];
  console.log(`APISTATE ACCOUNT SCORES mode=${String(value.mode)} calls=${String(value.recentCallLimit)} accounts=${accounts.length} databaseQueries=${String(value.databaseQueries)} queryDurationMs=${String(value.queryDurationMs)} totalDurationMs=${String(value.totalDurationMs)}`);
  console.log("GRADE  SCORE  CONF    ATTEMPTS  FAIL%  SWITCH%  TTFT_P95  PRIORITY  CURRENT      ACCOUNT  GROUPS");
  for (const row of accounts) {
    const failureRate = typeof row.failureRate === "number" ? `${(row.failureRate * 100).toFixed(1)}%` : "-";
    const failoverRate = typeof row.failoverRate === "number" ? `${(row.failoverRate * 100).toFixed(1)}%` : "-";
    const ttft = typeof row.ttftP95Ms === "number" ? `${Math.round(row.ttftP95Ms)}ms` : "-";
    const groups = Array.isArray(row.groupNames) ? row.groupNames.join(",") : "-";
    console.log([
      String(row.grade ?? "-").padEnd(5),
      (typeof row.score === "number" ? row.score.toFixed(1) : "-").padStart(5),
      String(row.confidence ?? "-").padEnd(7),
      String(row.observedAttempts ?? 0).padStart(8),
      failureRate.padStart(6),
      failoverRate.padStart(7),
      ttft.padStart(9),
      String(row.priority ?? "-").padStart(8),
      (row.currentAvailable === true ? "available" : row.currentAvailable === false ? "unavailable" : "unknown").padEnd(11),
      String(row.accountName ?? "-"),
      groups,
    ].join("  "));
  }
}

function emit(value: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log("APISTATE RESULT");
  console.log("FIELD                 VALUE");
  console.log("--------------------  ------------------------------------------------------------");
  for (const [key, item] of Object.entries(value)) {
    const rendered = item === null || item === undefined ? "-" : typeof item === "object" ? JSON.stringify(item) : String(item);
    console.log(`${key.padEnd(20)}  ${rendered}`);
  }
}

export function summarizeWorkflowStatus(value: Record<string, unknown>): Record<string, unknown> {
  const result = record(value.result);
  const summary: Record<string, unknown> = {
    target: value.target,
    transport: value.transport,
    ok: value.ok,
    workflowId: value.workflowId,
    runId: value.runId,
    state: value.state,
    terminal: value.terminal,
    error: value.error,
  };
  if (result) {
    summary.resultOk = result.ok;
    summary.resultStatus = result.status;
    summary.refreshedAt = result.refreshedAt;
    summary.window = result.window;
    summary.groupCount = Array.isArray(result.groups) ? result.groups.length : null;
    summary.accountCount = Array.isArray(result.accounts) ? result.accounts.length : null;
    summary.resultFieldCount = Object.keys(result).length;
    summary.disclosure = "add --json for the complete workflow result";
  } else if (value.result !== null && value.result !== undefined) {
    summary.resultType = Array.isArray(value.result) ? "array" : typeof value.result;
    summary.disclosure = "add --json for the complete workflow result";
  }
  return summary;
}

export function summarizeLifecycleResponse(value: Record<string, unknown>): Record<string, unknown> {
  const job = record(value.job);
  if (!job) return value;
  const result = record(job.result);
  const summary = record(result?.summary);
  const settlement = record(job.settlement);
  const accounting = record(settlement?.accounting);
  const entry = record(accounting?.entry);
  const logs = Array.isArray(job.logs) ? job.logs.map(record).filter((row): row is Record<string, unknown> => row !== null) : [];
  return {
    target: value.target,
    transport: value.transport,
    ok: value.ok,
    planId: job.id,
    state: job.state,
    day: record(job.settings)?.day,
    selectionMode: record(job.settings)?.selectionMode,
    scope: record(job.settings)?.scope,
    candidateCount: Array.isArray(job.candidates) ? job.candidates.length : 0,
    excludedRateLimited: summary?.excludedRateLimited ?? null,
    error: job.error ?? null,
    settlement: entry ? {
      accountCount: entry.accountCount,
      grossAcquisitionCostCny: entry.grossAcquisitionCostCny,
      apiAmountUsd: entry.apiAmountUsd,
      grossCnyPerApiUsd: entry.grossCnyPerApiUsd,
      remainingAccountCount: Array.isArray(settlement?.remainingAccountIds) ? settlement.remainingAccountIds.length : null,
    } : null,
    latestLog: logs.at(-1) ?? null,
    next: job.state === "queued" || job.state === "running"
      ? `accounts lifecycle retire status --id ${String(job.id)} --over-api`
      : job.state === "succeeded"
        ? `accounts lifecycle retire confirm --id ${String(job.id)} --confirm --over-api`
        : null,
    disclosure: "add --json for full candidates and logs",
  };
}

function appCommand(parsed: Parsed, config: ReturnType<typeof loadConfig>): AppCommand | Record<string, unknown> {
  const [group, action] = parsed.command;
  if (group === "backend" && action === "check") return { kind: "backend.check" };
  if (group === "scores" && action === "get") return { kind: "scores.get" };
  if (group === "scores" && action === "refresh") return { kind: "scores.refresh" };
  if (group === "lottery" && action === "status") return { kind: "lottery.status" };
  if (group === "lottery" && action === "draw") return parsed.confirm ? { kind: "lottery.draw" } : { ok: true, mutation: false, action: "lottery-draw", hint: "add --confirm to execute" };
  if (group === "lottery" && action === "reset") {
    const draws = parsed.draws ?? config.lottery.initialDrawCount;
    return parsed.confirm ? { kind: "lottery.reset", draws, includeRecords: parsed.includeRecords } : { ok: true, mutation: false, action: "lottery-reset", draws, includeRecords: parsed.includeRecords, hint: "add --confirm to execute" };
  }
  if (group === "records" && action === "list") return { kind: "records.list", limit: parsed.limit ?? config.records.publicLimit };
  if (group === "records" && action === "delete") {
    if (!parsed.id) throw new Error("records delete requires --id");
    return parsed.confirm ? { kind: "records.delete", id: parsed.id } : { ok: true, mutation: false, action: "record-delete", id: parsed.id, hint: "add --confirm to execute" };
  }
  if (group === "credit" && action === "test") return { kind: "credit.test", execute: parsed.confirm };
  throw new Error(`unknown command: ${parsed.command.join(" ")}`);
}

function isAppCommand(value: AppCommand | Record<string, unknown>): value is AppCommand {
  return typeof value.kind === "string";
}

async function embedded(parsed: Parsed, config: ReturnType<typeof loadConfig>, target: EmbeddedCliTarget): Promise<unknown> {
  if (parsed.command[0] === "priority") throw new Error("priority runtime CRUD requires --over-api");
  if (
    parsed.command.join(" ") === "scores priority-plan"
    || parsed.command.join(" ") === "scores rank"
    || parsed.command[0] === "errors"
    || parsed.command.join(" ") === "users impact"
    || parsed.command.join(" ") === "users balance-liability"
    || parsed.command.join(" ") === "profit daily-facts"
    || parsed.command.join(" ") === "accounts economics"
    || parsed.command.join(" ") === "accounts import-economics"
    || parsed.command.join(" ") === "accounts oauth-economics"
    || parsed.command.join(" ") === "accounts inspect"
    || (parsed.command[0] === "accounts" && parsed.command[1] === "lifecycle")
    || parsed.command.join(" ") === "payments alipay-revenue"
    || parsed.command.join(" ") === "reads status"
  ) {
    throw new Error("Sub2API production reads require the Native API transport");
  }
  if (parsed.command.join(" ") === "scores refresh" || parsed.command.join(" ") === "workflow status") {
    const temporal = await TemporalGateway.connect(config, { taskQueue: target.temporalTaskQueue });
    try {
      if (parsed.command[0] === "scores") return await temporal.submit({ kind: "scores.refresh" });
      if (!parsed.id) throw new Error("workflow status requires --id");
      return await temporal.status(parsed.id);
    } finally {
      await temporal.close();
    }
  }
  const command = appCommand(parsed, config);
  if (!isAppCommand(command)) return command;
  const context = createEmbeddedContext(config, target);
  let temporal: TemporalGateway | null = null;
  try {
    if (usesWorkflow(command)) temporal = await TemporalGateway.connect(config, { taskQueue: target.temporalTaskQueue });
    return await new ApplicationDispatcher({ lottery: context.service, scores: context.monitor }, temporal).dispatch(command);
  } finally {
    if (temporal) await temporal.close();
    context.close();
  }
}

async function remote(parsed: Parsed, config: ReturnType<typeof loadConfig>, target: HttpCliTarget): Promise<unknown> {
  const client = new AdminHttpClient(config, target);
  const [group, action] = parsed.command;
  if (group === "upstreams" && action === "list") return await client.upstreams(parsed.page ?? 1, parsed.search);
  if (group === "upstreams" && action === "usage") {
    const accountIds = parsed.accounts ? parseAccountIdSelector(parsed.accounts) : [];
    return await client.upstreamUsage(accountIds, `upstream-usage-${crypto.randomUUID()}`);
  }
  if (group === "upstreams" && action === "template") {
    const accountIds = parsed.accounts ? parseAccountIdSelector(parsed.accounts) : [];
    if (!parsed.confirm) return { ok: true, mutation: false, action: "upstream-template", accountIds, scope: accountIds.length ? "selected" : "all-api-key", hint: "add --confirm to execute" };
    return await client.upstreamTemplate(accountIds, `upstream-template-${crypto.randomUUID()}`);
  }
  if (group === "upstreams" && action === "status") {
    if (!parsed.id) throw new Error("upstreams status requires --id");
    return await client.upstreamJob(parsed.id);
  }
  if (group === "upstreams" && action === "create") {
    if (!parsed.baseUrl || !parsed.suffix || parsed.rate === null) throw new Error("upstreams create requires --base-url, --suffix, and --rate");
    if (!parsed.apiKeyStdin) throw new Error("upstreams create requires --api-key-stdin; API keys are never accepted in argv");
    const input = { baseUrl: parsed.baseUrl, suffix: parsed.suffix, rateCnyPerApiUsd: parsed.rate,
      priority: parsed.priority ?? 1, capacity: parsed.capacity ?? 16,
      groupIds: (parsed.groups ?? "2,3").split(",").map(Number), rechargeCny: parsed.rechargeCny };
    if (!parsed.confirm) return { ok: true, mutation: false, action: "upstream-create", plan: { ...input, apiKey: "stdin:redacted" }, hint: "add --confirm to execute" };
    const apiKey = (await Bun.stdin.text()).trim();
    if (!apiKey) throw new Error("--api-key-stdin received empty stdin");
    return await client.upstreamCreate({ ...input, apiKey }, `upstream-create-${crypto.randomUUID()}`);
  }
  if (group === "upstreams" && action === "update") {
    const id = Number(parsed.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("upstreams update requires a positive --id");
    if (parsed.suffix === null && parsed.rate === null && !parsed.templateOnly) throw new Error("upstreams update requires --suffix, --rate, or --template-only");
    const input = { ...(parsed.suffix === null ? {} : { suffix: parsed.suffix }), ...(parsed.rate === null ? {} : { rateCnyPerApiUsd: parsed.rate }) };
    if (!parsed.confirm) return { ok: true, mutation: false, action: "upstream-update", accountId: id, plan: input, hint: "add --confirm to execute" };
    return await client.upstreamUpdate(id, input, `upstream-update-${id}-${crypto.randomUUID()}`);
  }
  if (group === "payments" && action === "alipay-revenue") {
    return await client.alipayRevenue({ day: parsed.day, period: parsed.period });
  }
  if (group === "users" && action === "balance-liability") {
    return await client.userBalanceLiability();
  }
  if (group === "profit" && action === "daily-facts") {
    if (!parsed.day) throw new Error("profit daily-facts requires --day");
    return await client.dailyProfitFacts(parsed.day);
  }
  if (group === "profit" && action === "daily") {
    const day = parsed.day ?? new Date().toLocaleDateString("sv-SE", { timeZone: config.monitor.timezone });
    return await client.dailyProfit(day);
  }
  if (group === "accounts" && action === "economics") {
    if (!parsed.accounts) throw new Error("accounts economics requires --accounts");
    if (parsed.costCny === null) throw new Error("accounts economics requires --cost-cny");
    return await client.accountBatchEconomics({
      accountIds: parseAccountIdSelector(parsed.accounts),
      costCny: parsed.costCny,
      day: parsed.day,
      start: parsed.start,
      end: parsed.end,
    });
  }
  if (group === "accounts" && action === "import-economics") {
    if (!parsed.day) throw new Error("accounts import-economics requires --day");
    let externalCosts: unknown = [];
    if (parsed.externalCostsJson !== null) {
      try { externalCosts = JSON.parse(parsed.externalCostsJson); }
      catch { throw new Error("--external-costs-json must be valid JSON"); }
    }
    return await client.accountImportEconomics({ day: parsed.day, externalCosts });
  }
  if (group === "accounts" && action === "oauth-economics") {
    const profile = parsed.profile ?? "codex";
    if (profile !== "codex" && profile !== "grok") throw new Error("--profile must be codex or grok");
    return await client.oauthPoolEconomics(profile);
  }
  if (group === "accounts" && action === "delete") {
    if (!parsed.accounts) throw new Error("accounts delete requires --accounts");
    return await client.deleteAccounts(parseAccountIdSelector(parsed.accounts), parsed.confirm);
  }
  if (group === "accounts" && action === "import") {
    if (!parsed.file) throw new Error("accounts import requires --file");
    if (parsed.unitCostCny === null) throw new Error("accounts import requires --unit-cost-cny in CNY");
    const defaults = config.operations.accountImportDefaults;
    const inferredPlanType = parsed.unitCostCny < defaults.freeCostThresholdCny ? "free"
      : parsed.unitCostCny > defaults.plusCostThresholdCny ? "plus" : "k12";
    const planType = parsed.planType ?? inferredPlanType;
    if (planType !== "k12" && planType !== "plus" && planType !== "team" && planType !== "free") {
      throw new Error("--plan-type must be k12, plus, team, or free");
    }
    const groupIds = (parsed.groups ?? defaults.groupIds.join(",")).split(",").map(Number);
    const zip = parsed.file.toLowerCase().endsWith(".zip");
    return await client.accountImport({ content: readFileSync(parsed.file, zip ? "base64" : "utf8"), inputFormat: zip ? "zip" : "json",
      priority: parsed.priority ?? defaults.priority,
      capacity: parsed.capacity ?? defaults.capacity, groupIds, sourceProxyId: parsed.proxyId ?? defaults.sourceProxyId,
      unitCostCny: parsed.unitCostCny, planType, confirm: parsed.confirm });
  }
  if (group === "accounts" && action === "lifecycle") {
    const verb = parsed.command[2];
    if (verb === "detect") {
      if (!parsed.day) throw new Error("accounts lifecycle detect requires --day");
      if (parsed.planType !== "k12" && parsed.planType !== "plus") throw new Error("--plan-type must be k12 or plus");
      return await client.accountLifecycleDetect({ day: parsed.day, planType: parsed.planType, model: parsed.model, confirm: parsed.confirm });
    }
    if (verb === "retire") {
      const phase = parsed.command[3];
      if (phase === "plan") {
        if (parsed.confirm) throw new Error("retire plan does not accept --confirm; create the plan first");
        const scope = parsed.scope ?? "pool";
        if (scope !== "pool" && scope !== "day") throw new Error("--scope must be pool or day");
        const day = parsed.day ?? new Date().toLocaleDateString("sv-SE", { timeZone: config.monitor.timezone });
        return await client.accountLifecycleDetect({ day, planType: "all", scope, selectionMode: "database-dead", confirm: false });
      }
      if (!parsed.id) throw new Error(`accounts lifecycle retire ${phase ?? ""} requires --id`);
      if (phase === "status") return await client.accountLifecycleStatus(parsed.id);
      if (phase === "confirm") {
        if (!parsed.confirm) return { ok: true, mutation: false, planId: parsed.id,
          hint: `review with accounts lifecycle retire status --id ${parsed.id}, then add --confirm` };
        const status = await client.accountLifecycleStatus(parsed.id);
        const job = record(status.job);
        const settings = record(job?.settings);
        if (!job || (settings?.selectionMode !== "database-error" && settings?.selectionMode !== "database-dead")) throw new Error("retire confirm requires a database retirement plan");
        if (job.state !== "succeeded") throw new Error(`retirement plan must be succeeded before confirm; current state is ${String(job.state)}`);
        return await client.accountLifecycleSettle(parsed.id);
      }
      throw new Error("accounts lifecycle retire requires plan, status, or confirm");
    }
    if (!parsed.id) throw new Error(`accounts lifecycle ${verb ?? ""} requires --id`);
    if (verb === "status") return await client.accountLifecycleStatus(parsed.id);
    throw new Error("accounts lifecycle requires detect, status, or retire plan|status|confirm");
  }
  if (group === "accounts" && action === "status") {
    if (!parsed.id) throw new Error("accounts status requires --id");
    return await client.accountImportStatus(parsed.id);
  }
  if (group === "accounts" && action === "inspect") {
    if (!parsed.accounts) throw new Error("accounts inspect requires --accounts");
    return await client.inspectAccounts(parseAccountIdSelector(parsed.accounts));
  }
  if (group === "priority" && action === "history") return await client.priorityHistory();
  if (group === "priority" && action === "plan") {
    const verb = parsed.command[2];
    if (verb === "create") return await client.createPriorityPlan(parsed.calls ?? config.monitor.recentCallLimit);
    if (verb === "confirm") {
      if (!parsed.id) throw new Error("priority plan confirm requires --id");
      return parsed.confirm ? await client.confirmPriorityPlan(parsed.id)
        : { ok: true, mutation: false, id: parsed.id, hint: "add --confirm to execute" };
    }
    throw new Error("priority plan requires create or confirm");
  }
  if (group === "priority" && parsed.command[1] === "automation") {
    const verb = parsed.command[2];
    if (verb === "get") return await client.priorityAutomation();
    if (verb === "delete") {
      return parsed.confirm ? await client.deletePriorityAutomation()
        : { ok: true, mutation: false, hint: "add --confirm to delete priority automation" };
    }
    if (verb === "create" || verb === "update") {
      if (parsed.intervalSeconds === null || parsed.calls === null || parsed.enabled === null) {
        throw new Error(`${verb} requires --interval-seconds, --calls, and --enabled`);
      }
      const input = { intervalSeconds: parsed.intervalSeconds, recentCallLimit: parsed.calls, enabled: parsed.enabled };
      if (!parsed.confirm) return { ok: true, mutation: false, action: `priority-automation-${verb}`, plan: input, hint: "add --confirm to execute" };
      return verb === "create" ? await client.createPriorityAutomation(input) : await client.updatePriorityAutomation(input);
    }
    throw new Error("priority automation requires get, create, update, or delete");
  }
  if (group === "backend" && action === "check") return await client.backendCheck();
  if (group === "scores" && action === "get") return await client.scores();
  if (group === "scores" && action === "refresh") return await client.workflowSubmit({ kind: "scores.refresh" });
  if (group === "scores" && action === "rank") {
    return await client.rankScores(parsed.calls ?? config.monitor.recentCallLimit, parsed.account, parsed.group);
  }
  if (group === "scores" && action === "priority-plan") {
    return await client.priorityState(
      parsed.calls ?? config.monitor.recentCallLimit,
      parsed.account,
      parsed.group,
    );
  }
  if (group === "reads" && action === "status") return await client.readStatus();
  if (group === "errors" && action === "aggregate") {
    return await client.errorAggregate(
      parsed.limit ?? config.monitor.errorAggregateLimit,
      parsed.top ?? config.monitor.errorAggregateTop,
      parsed.account,
      parsed.group,
    );
  }
  if (group === "errors" && action === "diagnose") {
    return await client.errorDiagnose(
      parsed.limit ?? config.monitor.errorAggregateLimit,
      parsed.top ?? config.monitor.errorAggregateTop,
      parsed.account,
      parsed.group,
      null,
    );
  }
  if (group === "errors" && action === "list") {
    return await client.errorList(parsed.limit ?? config.monitor.errorAggregateLimit);
  }
  if (group === "errors" && action === "get") {
    if (!parsed.requestId) throw new Error("errors get requires --request-id");
    return await client.errorRequest(parsed.requestId);
  }
  if (group === "users" && action === "impact") {
    if (!parsed.start || !parsed.end) throw new Error("users impact requires --start and --end");
    return await client.userImpact(parsed.start, parsed.end, parsed.affectedOnly);
  }
  if (group === "workflow" && action === "status") {
    if (!parsed.id) throw new Error("workflow status requires --id");
    return await client.workflowStatus(parsed.id);
  }
  if (group === "lottery" && action === "status") return await client.status();
  if (group === "lottery" && action === "draw") return parsed.confirm ? await client.draw() : { ok: true, mutation: false, action: "lottery-draw", hint: "add --confirm to execute" };
  if (group === "lottery" && action === "reset") {
    const draws = parsed.draws ?? config.lottery.initialDrawCount;
    return parsed.confirm ? await client.reset(draws, parsed.includeRecords) : { ok: true, mutation: false, action: "lottery-reset", draws, includeRecords: parsed.includeRecords, hint: "add --confirm to execute" };
  }
  if (group === "records" && action === "list") return await client.records(parsed.limit ?? config.records.publicLimit);
  if (group === "records" && action === "delete") {
    if (!parsed.id) throw new Error("records delete requires --id");
    return parsed.confirm ? await client.deleteRecord(parsed.id) : { ok: true, mutation: false, action: "record-delete", id: parsed.id, hint: "add --confirm to execute" };
  }
  if (group === "credit" && action === "test") return await client.creditTest(parsed.confirm);
  if (group === "api" && action === "smoke") {
    const [status, scores, ranking, lottery] = await Promise.all([client.serviceStatus(), client.scores(), client.ranking(), client.lottery()]);
    const refreshed = await client.workflowSubmit({ kind: "scores.refresh" });
    return {
      ok: status.ok === true && scores.ok === true && refreshed.ok === true && ranking.ok === true && lottery.ok === true,
      action: "apistate-api-smoke",
      checks: { status: status.ok === true, scores: scores.ok === true, refreshSubmitted: refreshed.ok === true, ranking: ranking.ok === true, lottery: lottery.ok === true },
      workflowId: refreshed.workflowId,
      runId: refreshed.runId,
      state: refreshed.state,
      next: "workflow status --id <workflowId>",
      valuesPrinted: false,
    };
  }
  throw new Error(`unknown command: ${parsed.command.join(" ")}`);
}

function aggregateSmoke(): Record<string, unknown> {
  const account = (groupId: number, groupName: string, successRequests: number, failureRequests: number, ttftP95Ms: number, apiAmountUsd: number) => ({
    accountId: 15, accountName: "lyon9801 0.0", groupId, groupName, status: "active", currentlyAvailable: true, priority: 1,
    successRequests, failureRequests, observedAttempts: successRequests + failureRequests, streamSuccessRequests: successRequests,
    firstTokenSamples: successRequests, ttftP95Ms, usage: { requestCount: successRequests, tokenCount: successRequests * 1000, apiAmountUsd },
  });
  const rows = mergeAccountScores([account(3, "自用", 100, 0, 10_591, 1), account(2, "unidesk-codex-pool", 50, 1, 13_206, 0.5)]);
  const row = rows[0] ?? {};
  const checks = {
    uniqueAccount: rows.length === 1,
    groupsMerged: Array.isArray(row.groupNames) && row.groupNames.length === 2,
    attemptsMerged: row.observedAttempts === 151,
    usageMerged: record(row.usage)?.requestCount === 150 && record(row.usage)?.apiAmountUsd === 1.5,
    decimalScore: typeof row.score === "number" && !Number.isInteger(row.score),
    conservativeTtft: row.ttftP95Ms === 13_206,
  };
  return { ok: Object.values(checks).every(Boolean), action: "account-score-aggregate-smoke", checks, mutation: false };
}

export async function runCli(args: string[]): Promise<void> {
  const wantsJson = args.includes("--json");
  try {
    if (args.includes("--help") || args.length === 0) return emit(help(), wantsJson);
    const parsed = parseArgs(args);
    const config = loadConfig(parsed.configPath);
    if (parsed.command.join(" ") === "config validate") return emit({
      ok: true, configPath: config.configPath, kind: config.kind, service: config.metadata.name,
      temporalNamespace: config.temporal.namespace,
      temporalTaskQueue: config.temporal.taskQueue,
      cliTargets: Object.fromEntries(Object.entries(config.runtime.cliTargets).map(([id, target]) => [id, target.mode === "embedded" ? { mode: target.mode, temporalTaskQueue: target.temporalTaskQueue } : { mode: target.mode }])),
      serverTargets: Object.fromEntries(Object.entries(config.runtime.serverTargets).map(([id, target]) => [id, { temporalTaskQueue: target.temporalTaskQueue, scoreScheduleWorkflowId: target.scoreScheduleWorkflowId }])),
      refreshIntervalMinutes: config.monitor.refreshIntervalMinutes, recentCallLimit: config.monitor.recentCallLimit,
      automaticCreditEnabled: config.lottery.automaticCredit.enabled, valuesPrinted: false,
    }, parsed.json);
    if (parsed.command.join(" ") === "scores aggregate-smoke") return emit(aggregateSmoke(), parsed.json);
    if (parsed.command[0] === "native") {
      const action = parsed.command[1];
      if (action !== "start" && action !== "stop" && action !== "status" && action !== "logs") {
        throw new Error(`unknown native action ${action ?? ""}`);
      }
      if (parsed.component === null || parsed.component === "all") {
        return emit(nativeAll(config, action, parsed.tail ?? 40), parsed.json);
      }
      const result = action === "start" ? nativeStart(config, parsed.component)
        : action === "stop" ? nativeStop(config, parsed.component)
        : action === "status" ? nativeStatus(config, parsed.component)
        : nativeLogs(config, parsed.component, parsed.tail ?? 40);
      return emit(result, parsed.json);
    }
    const nativeReadCommand = (
      parsed.command.join(" ") === "scores rank"
      || parsed.command.join(" ") === "scores priority-plan"
      || parsed.command.join(" ") === "reads status"
      || parsed.command[0] === "errors"
      || parsed.command.join(" ") === "users impact"
      || parsed.command.join(" ") === "users balance-liability"
      || parsed.command.join(" ") === "profit daily-facts"
      || parsed.command.join(" ") === "profit daily"
      || parsed.command.join(" ") === "accounts economics"
      || parsed.command.join(" ") === "accounts import-economics"
      || parsed.command.join(" ") === "accounts oauth-economics"
      || parsed.command.join(" ") === "accounts inspect"
      || (parsed.command[0] === "accounts" && parsed.command[1] === "lifecycle")
      || parsed.command.join(" ") === "payments alipay-revenue"
    );
    const targetId = parsed.targetId ?? (
      parsed.overApi || nativeReadCommand
        ? config.runtime.overApiTarget
        : config.runtime.defaultCliTarget
    );
    const target = config.runtime.cliTargets[targetId];
    if (!target) throw new Error(`runtime.cliTargets.${targetId} does not exist`);
    if (parsed.overApi && target.mode !== "http") throw new Error(`--over-api requires an http target; ${targetId} is ${target.mode}`);
    const result = target.mode === "embedded" ? await embedded(parsed, config, target) : await remote(parsed, config, target);
    const output = { target: targetId, transport: target.mode === "embedded" ? "local-dispatcher" : "http", ...result as Record<string, unknown> };
    if (parsed.command.join(" ") === "scores rank") emitScoreRanking(output, parsed.json);
    else if (parsed.command.join(" ") === "scores priority-plan") emitPriorityPlan(output, parsed.json);
    else if (parsed.command.join(" ") === "errors aggregate") emitErrorAggregate(output, parsed.json);
    else if (parsed.command.join(" ") === "errors diagnose") emitErrorDiagnosis(output, parsed.json);
    else if (parsed.command.join(" ") === "users impact") emitUserImpact(output, parsed.json);
    else if (parsed.command.join(" ") === "accounts economics") emitAccountEconomics(output, parsed.json);
    else if (parsed.command.join(" ") === "accounts import-economics") emitAccountImportEconomics(output, parsed.json);
    else if (parsed.command.join(" ") === "accounts oauth-economics") emitOAuthEconomics(output, parsed.json);
    else if (parsed.command.join(" ") === "profit daily") emitDailyProfit(output, parsed.json);
    else if (parsed.command[0] === "accounts" && parsed.command[1] === "lifecycle" && !parsed.json) emit(summarizeLifecycleResponse(output), false);
    else emit(parsed.command.join(" ") === "workflow status" && !parsed.json ? summarizeWorkflowStatus(output) : output, parsed.json);
  } catch (error) {
    emit({ ok: false, error: error instanceof Error ? error.message : String(error), valuesPrinted: false }, wantsJson);
    process.exitCode = 1;
  }
}
