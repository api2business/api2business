import { AdminHttpClient } from "../../src/admin-http-client";
import { mergeAccountScores } from "../../src/account-score-aggregation";
import { collectRecentCallScoresFromDatabase } from "../../src/account-score-database";
import { buildAccountPriorityPlan } from "../../src/account-priority-plan";
import { collectErrorAggregateFromDatabase } from "../../src/error-aggregate-database";
import { collectErrorListFromDatabase, collectErrorRequestFromDatabase } from "../../src/error-detail-database";
import { createEmbeddedContext } from "../../src/bootstrap";
import { loadConfig, type EmbeddedCliTarget, type HttpCliTarget, type NativeServiceId } from "../../src/config";
import type { AppCommand } from "../../src/contracts";
import { usesWorkflow } from "../../src/contracts";
import { ApplicationDispatcher } from "../../src/dispatcher";
import { nativeLogs, nativeStart, nativeStatus, nativeStop } from "../../src/native-services";
import { TemporalGateway } from "../../src/temporal-client";
import { collectUserImpactFromDatabase } from "../../src/user-impact-database";
import { emitUserImpact } from "./user-impact-output";
import { emitErrorAggregate } from "./error-aggregate-output";
import { emitPriorityPlan } from "./priority-plan-output";

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
  component: NativeServiceId | null;
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
  const optionNames = new Set(["--config", "--target", "--id", "--request-id", "--limit", "--top", "--draws", "--component", "--tail", "--calls", "--account", "--group", "--start", "--end"]);
  const flags = new Set(["--confirm", "--include-records", "--over-api", "--json", "--affected-only"]);
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
  if (component !== null && component !== "api" && component !== "worker" && component !== "web") throw new Error("--component must be api, worker, or web");
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
    group: value(args, "--group"),
    start: value(args, "--start"),
    end: value(args, "--end"),
    affectedOnly: args.includes("--affected-only"),
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
      "errors aggregate [--limit N] [--top N] [--account <id-or-name>] [--group <id-or-exact-name>]",
      "errors list [--limit N]",
      "errors get --request-id <request-id>",
      "users impact --start <ISO> --end <ISO> [--affected-only]",
      "lottery status|draw|reset",
      "records list|delete",
      "credit test",
      "api smoke --over-api",
      "workflow status --id <workflow-id>",
      "native start|stop|status|logs --component api|worker|web [--tail N]",
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
  if (parsed.command.join(" ") === "scores priority-plan") {
    const ranking = await collectRecentCallScoresFromDatabase(
      config,
      parsed.calls ?? config.monitor.recentCallLimit,
      parsed.account,
      parsed.group,
    );
    return buildAccountPriorityPlan(ranking, config);
  }
  if (parsed.command.join(" ") === "scores rank") {
    return await collectRecentCallScoresFromDatabase(
      config,
      parsed.calls ?? config.monitor.recentCallLimit,
      parsed.account,
      parsed.group,
    );
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
  if (group === "backend" && action === "check") return await client.backendCheck();
  if (group === "scores" && action === "get") return await client.scores();
  if (group === "scores" && action === "refresh") return await client.workflowSubmit({ kind: "scores.refresh" });
  if (group === "scores" && action === "rank") {
    return await client.rankScores(parsed.calls ?? config.monitor.recentCallLimit, parsed.account, parsed.group);
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
      refreshIntervalMinutes: config.monitor.refreshIntervalMinutes, scoreWindow: config.monitor.scoreWindow,
      automaticCreditEnabled: config.lottery.automaticCredit.enabled, valuesPrinted: false,
    }, parsed.json);
    if (parsed.command.join(" ") === "scores aggregate-smoke") return emit(aggregateSmoke(), parsed.json);
    if (parsed.command.join(" ") === "errors aggregate") {
      if (parsed.overApi) throw new Error("errors aggregate uses direct PostgreSQL and does not support --over-api");
      const result = await collectErrorAggregateFromDatabase(
        config,
        parsed.limit ?? config.monitor.errorAggregateLimit,
        parsed.top ?? config.monitor.errorAggregateTop,
        parsed.account,
        parsed.group,
      );
      return emitErrorAggregate({ target: "database", transport: "postgresql-direct", ...result }, parsed.json);
    }
    if (parsed.command.join(" ") === "errors list") {
      if (parsed.overApi) throw new Error("errors list uses direct PostgreSQL and does not support --over-api");
      const result = await collectErrorListFromDatabase(config, parsed.limit ?? config.monitor.errorAggregateLimit);
      return emit({ target: "database", transport: "postgresql-direct", ...result }, parsed.json);
    }
    if (parsed.command.join(" ") === "errors get") {
      if (parsed.overApi) throw new Error("errors get uses direct PostgreSQL and does not support --over-api");
      if (!parsed.requestId) throw new Error("errors get requires --request-id");
      const result = await collectErrorRequestFromDatabase(config, parsed.requestId);
      return emit({ target: "database", transport: "postgresql-direct", ...result }, parsed.json);
    }
    if (parsed.command.join(" ") === "users impact") {
      if (parsed.overApi) throw new Error("users impact uses direct PostgreSQL and does not support --over-api");
      if (!parsed.start || !parsed.end) throw new Error("users impact requires --start and --end");
      const result = await collectUserImpactFromDatabase(config, parsed.start, parsed.end, parsed.affectedOnly);
      return emitUserImpact({ target: "database", transport: "postgresql-direct", ...result }, parsed.json);
    }
    if (parsed.command[0] === "native") {
      const action = parsed.command[1];
      if (!parsed.component) throw new Error("native commands require --component api, worker, or web");
      const result = action === "start" ? nativeStart(config, parsed.component)
        : action === "stop" ? nativeStop(config, parsed.component)
        : action === "status" ? nativeStatus(config, parsed.component)
        : action === "logs" ? nativeLogs(config, parsed.component, parsed.tail ?? 40)
        : (() => { throw new Error(`unknown native action ${action ?? ""}`); })();
      return emit(result, parsed.json);
    }
    const targetId = parsed.targetId ?? (parsed.overApi ? config.runtime.overApiTarget : config.runtime.defaultCliTarget);
    const target = config.runtime.cliTargets[targetId];
    if (!target) throw new Error(`runtime.cliTargets.${targetId} does not exist`);
    if (parsed.overApi && target.mode !== "http") throw new Error(`--over-api requires an http target; ${targetId} is ${target.mode}`);
    const result = target.mode === "embedded" ? await embedded(parsed, config, target) : await remote(parsed, config, target);
    const output = { target: targetId, transport: target.mode === "embedded" ? "local-dispatcher" : "http", ...result as Record<string, unknown> };
    if (parsed.command.join(" ") === "scores rank") emitScoreRanking(output, parsed.json);
    else if (parsed.command.join(" ") === "scores priority-plan") emitPriorityPlan(output, parsed.json);
    else emit(parsed.command.join(" ") === "workflow status" && !parsed.json ? summarizeWorkflowStatus(output) : output, parsed.json);
  } catch (error) {
    emit({ ok: false, error: error instanceof Error ? error.message : String(error), valuesPrinted: false }, wantsJson);
    process.exitCode = 1;
  }
}
