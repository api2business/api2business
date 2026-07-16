import { AdminHttpClient } from "../../src/admin-http-client";
import { mergeAccountScores } from "../../src/account-score-aggregation";
import { createEmbeddedContext } from "../../src/bootstrap";
import { loadConfig, type EmbeddedCliTarget, type HttpCliTarget } from "../../src/config";

interface Parsed {
  configPath: string;
  targetId: string | null;
  command: string[];
  confirm: boolean;
  includeRecords: boolean;
  id: string | null;
  limit: number | null;
  draws: number | null;
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
  const optionNames = new Set(["--config", "--target", "--id", "--limit", "--draws"]);
  const flags = new Set(["--confirm", "--include-records"]);
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
  return {
    configPath,
    targetId: value(args, "--target"),
    command,
    confirm: args.includes("--confirm"),
    includeRecords: args.includes("--include-records"),
    id: value(args, "--id"),
    limit: integer("--limit"),
    draws: integer("--draws"),
  };
}

function help(): Record<string, unknown> {
  return {
    ok: true,
    usage: "bun scripts/apistate-cli.ts --config config/sub2rank.yaml [--target local|production] <command>",
    commands: [
      "config validate",
      "backend check",
      "scores aggregate-smoke",
      "lottery status",
      "lottery draw [--confirm]",
      "lottery reset [--draws N] [--include-records] --confirm",
      "records list [--limit N]",
      "records delete --id <record-id> --confirm",
      "credit test [--confirm]",
      "api smoke",
    ],
  };
}

async function embedded(parsed: Parsed, config: ReturnType<typeof loadConfig>, target: EmbeddedCliTarget): Promise<unknown> {
  const context = createEmbeddedContext(config, target);
  try {
    const [group, action] = parsed.command;
    if (group === "backend" && action === "check") return await context.service.status(true);
    if (group === "lottery" && action === "status") return await context.service.status(false);
    if (group === "lottery" && action === "draw") return parsed.confirm ? { ok: true, record: await context.service.draw() } : { ok: true, mutation: false, action: "lottery-draw", hint: "add --confirm to execute" };
    if (group === "lottery" && action === "reset") {
      const draws = parsed.draws ?? config.lottery.initialDrawCount;
      return parsed.confirm ? context.service.reset(draws, parsed.includeRecords) : { ok: true, mutation: false, action: "lottery-reset", draws, includeRecords: parsed.includeRecords, hint: "add --confirm to execute" };
    }
    if (group === "records" && action === "list") return { ok: true, records: context.service.listRecords(parsed.limit ?? config.records.publicLimit) };
    if (group === "records" && action === "delete") {
      if (!parsed.id) throw new Error("records delete requires --id");
      return parsed.confirm ? context.service.deleteRecord(parsed.id) : { ok: true, mutation: false, action: "record-delete", id: parsed.id, hint: "add --confirm to execute" };
    }
    if (group === "credit" && action === "test") return await context.service.creditTest(parsed.confirm);
    throw new Error(`unknown command: ${parsed.command.join(" ")}`);
  } finally {
    context.close();
  }
}

async function remote(parsed: Parsed, config: ReturnType<typeof loadConfig>, target: HttpCliTarget): Promise<unknown> {
  const client = new AdminHttpClient(config, target);
  const [group, action] = parsed.command;
  if (group === "backend" && action === "check") return await client.backendCheck();
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
    const [status, scores, ranking, lottery] = await Promise.all([
      client.serviceStatus(),
      client.scores(),
      client.ranking(),
      client.lottery(),
    ]);
    const refreshed = await client.refreshScores();
    return {
      ok: true,
      action: "apistate-api-smoke",
      checks: {
        status: status.ok === true,
        scores: scores.ok === true,
        refresh: refreshed.ok === true && refreshed.snapshotOk === true,
        ranking: ranking.ok === true,
        lottery: lottery.ok === true,
      },
      valuesPrinted: false,
    };
  }
  throw new Error(`unknown command: ${parsed.command.join(" ")}`);
}

export async function runCli(args: string[]): Promise<void> {
  try {
    if (args.includes("--help") || args.length === 0) {
      console.log(JSON.stringify(help(), null, 2));
      return;
    }
    const parsed = parseArgs(args);
    const config = loadConfig(parsed.configPath);
    if (parsed.command.join(" ") === "config validate") {
      console.log(JSON.stringify({
        ok: true,
        configPath: config.configPath,
        kind: config.kind,
        service: config.metadata.name,
        refreshIntervalMinutes: config.monitor.refreshIntervalMinutes,
        scoreWindow: config.monitor.scoreWindow,
        automaticCreditEnabled: config.lottery.automaticCredit.enabled,
        excludedIdentities: config.lottery.eligibility.excludedIdentities,
        valuesPrinted: false,
      }, null, 2));
      return;
    }
    if (parsed.command.join(" ") === "scores aggregate-smoke") {
      const account = (groupId: number, groupName: string, successRequests: number, failureRequests: number, ttftP95Ms: number, apiAmountUsd: number) => ({
        accountId: 15,
        accountName: "lyon9801 0.0",
        groupId,
        groupName,
        status: "active",
        currentlyAvailable: true,
        priority: 1,
        successRequests,
        failureRequests,
        observedAttempts: successRequests + failureRequests,
        streamSuccessRequests: successRequests,
        firstTokenSamples: successRequests,
        ttftP95Ms,
        usage: { requestCount: successRequests, tokenCount: successRequests * 1000, apiAmountUsd },
      });
      const rows = mergeAccountScores([
        account(3, "自用", 100, 0, 10_591, 1),
        account(2, "unidesk-codex-pool", 50, 1, 13_206, 0.5),
      ]);
      const row = rows[0] ?? {};
      const checks = {
        uniqueAccount: rows.length === 1,
        groupsMerged: Array.isArray(row.groupNames) && row.groupNames.length === 2,
        attemptsMerged: row.observedAttempts === 151,
        usageMerged: record(row.usage)?.requestCount === 150 && record(row.usage)?.apiAmountUsd === 1.5,
        decimalScore: typeof row.score === "number" && !Number.isInteger(row.score),
        conservativeTtft: row.ttftP95Ms === 13_206,
      };
      console.log(JSON.stringify({
        ok: Object.values(checks).every(Boolean),
        action: "account-score-aggregate-smoke",
        checks,
        result: {
          accountId: row.accountId,
          accountName: row.accountName,
          groupNames: row.groupNames,
          observedAttempts: row.observedAttempts,
          score: row.score,
          ttftP95Ms: row.ttftP95Ms,
          usage: row.usage,
        },
        mutation: false,
      }, null, 2));
      return;
    }
    const targetId = parsed.targetId ?? config.runtime.defaultCliTarget;
    const target = config.runtime.cliTargets[targetId];
    if (!target) throw new Error(`runtime.cliTargets.${targetId} does not exist`);
    const result = target.mode === "embedded" ? await embedded(parsed, config, target) : await remote(parsed, config, target);
    console.log(JSON.stringify({ target: targetId, ...result as Record<string, unknown> }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}
