import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DateTime } from "luxon";
import { parse } from "yaml";

export type IdentityField = "username" | "email" | "emailLocalPart";

export interface SecretRef {
  sourceRef: string;
  sourceKey: string;
}

export interface AppConfig {
  apiVersion: string;
  kind: string;
  metadata: { name: string; owner: string };
  monitor: {
    timezone: string;
    refreshIntervalMinutes: number;
    scoreWindow: string;
    target: string;
    cli: { workDir: string; executable: string; entrypoint: string; mainServerHost: string; timeoutMs: number };
  };
  webAuth: { username: string; cookieName: string; sessionTtlSeconds: number };
  sub2api: {
    baseUrl: string;
    requestTimeoutMs: number;
    pageSize: number;
    adminCredentials: { sourceRef: string; emailKey: string; passwordKey: string };
  };
  lottery: {
    timezone: string;
    initialDrawCount: number;
    dailyGrant: { hour: number; minute: number; count: number };
    eligibility: {
      activeWithinHours: number;
      statuses: string[];
      excludedRoles: string[];
      excludedIdentities: string[];
      identityFields: IdentityField[];
    };
    prize: { amountUsd: number };
    automaticCredit: { enabled: boolean; mode: "dry-run" | "live"; notesPrefix: string };
    creditTest: {
      targetIdentifier: string;
      identityFields: IdentityField[];
      amountUsd: number;
      notes: string;
    };
  };
  ranking: { timezone: string; windowDays: number; sourceLimit: number; displayLimit: number };
  records: { publicLimit: number };
  runtime: {
    secretsRoot: string;
    secretSourcePaths: Record<string, string>;
    defaultCliTarget: string;
    cliTargets: Record<string, EmbeddedCliTarget | HttpCliTarget>;
    serverTargets: Record<string, ServerTarget>;
  };
  configPath: string;
  rootDirectory: string;
}

export interface EmbeddedCliTarget {
  mode: "embedded";
  databasePath: string;
}

export interface HttpCliTarget {
  mode: "http";
  baseUrl: string;
  adminToken: SecretRef;
}

export interface ServerTarget {
  listenHost: string;
  listenPort: number;
  databasePath: string;
  adminTokenEnv: string;
  sub2apiAdminEmailEnv: string;
  sub2apiAdminPasswordEnv: string;
  webPasswordEnv: string;
  apiKeyEnv: string;
  sessionSecretEnv: string;
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown, path: string): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as ObjectValue;
}

function stringValue(parent: ObjectValue, key: string, path: string): string {
  const value = parent[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path}.${key} must be a non-empty string`);
  return value;
}

function numberValue(parent: ObjectValue, key: string, path: string, minimum = 0): number {
  const value = parent[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error(`${path}.${key} must be a number >= ${minimum}`);
  return value;
}

function integerValue(parent: ObjectValue, key: string, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = parent[key];
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${path}.${key} must be an integer between ${minimum} and ${maximum}`);
  return Number(value);
}

function timezoneValue(parent: ObjectValue, key: string, path: string): string {
  const value = stringValue(parent, key, path);
  if (!DateTime.now().setZone(value).isValid) throw new Error(`${path}.${key} must be a valid IANA timezone`);
  return value;
}

function booleanValue(parent: ObjectValue, key: string, path: string): boolean {
  const value = parent[key];
  if (typeof value !== "boolean") throw new Error(`${path}.${key} must be boolean`);
  return value;
}

function strings(parent: ObjectValue, key: string, path: string): string[] {
  const value = parent[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) throw new Error(`${path}.${key} must be a string array`);
  return value as string[];
}

function identityFields(parent: ObjectValue, key: string, path: string): IdentityField[] {
  const values = strings(parent, key, path);
  const supported = new Set(["username", "email", "emailLocalPart"]);
  if (values.some((value) => !supported.has(value))) throw new Error(`${path}.${key} contains an unsupported identity field`);
  return values as IdentityField[];
}

function secretRef(value: unknown, path: string): SecretRef {
  const raw = object(value, path);
  return { sourceRef: stringValue(raw, "sourceRef", path), sourceKey: stringValue(raw, "sourceKey", path) };
}

export function loadConfig(path: string): AppConfig {
  const configPath = resolve(path);
  const rootDirectory = resolve(dirname(configPath), "..");
  const raw = object(parse(readFileSync(configPath, "utf8")), "config");
  const metadata = object(raw.metadata, "metadata");
  const sub2api = object(raw.sub2api, "sub2api");
  const monitor = object(raw.monitor, "monitor");
  const monitorCli = object(monitor.cli, "monitor.cli");
  const webAuth = object(raw.webAuth, "webAuth");
  const adminCredentials = object(sub2api.adminCredentials, "sub2api.adminCredentials");
  const lottery = object(raw.lottery, "lottery");
  const dailyGrant = object(lottery.dailyGrant, "lottery.dailyGrant");
  const eligibility = object(lottery.eligibility, "lottery.eligibility");
  const prize = object(lottery.prize, "lottery.prize");
  const automaticCredit = object(lottery.automaticCredit, "lottery.automaticCredit");
  const creditTest = object(lottery.creditTest, "lottery.creditTest");
  const ranking = object(raw.ranking, "ranking");
  const records = object(raw.records, "records");
  const runtime = object(raw.runtime, "runtime");
  const secretSourcePathsRaw = object(runtime.secretSourcePaths, "runtime.secretSourcePaths");
  const cliTargetsRaw = object(runtime.cliTargets, "runtime.cliTargets");
  const serverTargetsRaw = object(runtime.serverTargets, "runtime.serverTargets");
  const cliTargets: Record<string, EmbeddedCliTarget | HttpCliTarget> = {};
  for (const [id, value] of Object.entries(cliTargetsRaw)) {
    const target = object(value, `runtime.cliTargets.${id}`);
    const mode = stringValue(target, "mode", `runtime.cliTargets.${id}`);
    if (mode === "embedded") cliTargets[id] = { mode, databasePath: stringValue(target, "databasePath", `runtime.cliTargets.${id}`) };
    else if (mode === "http") cliTargets[id] = { mode, baseUrl: stringValue(target, "baseUrl", `runtime.cliTargets.${id}`), adminToken: secretRef(target.adminToken, `runtime.cliTargets.${id}.adminToken`) };
    else throw new Error(`runtime.cliTargets.${id}.mode must be embedded or http`);
  }
  const serverTargets: Record<string, ServerTarget> = {};
  for (const [id, value] of Object.entries(serverTargetsRaw)) {
    const target = object(value, `runtime.serverTargets.${id}`);
    serverTargets[id] = {
      listenHost: stringValue(target, "listenHost", `runtime.serverTargets.${id}`),
      listenPort: numberValue(target, "listenPort", `runtime.serverTargets.${id}`, 1),
      databasePath: stringValue(target, "databasePath", `runtime.serverTargets.${id}`),
      adminTokenEnv: stringValue(target, "adminTokenEnv", `runtime.serverTargets.${id}`),
      sub2apiAdminEmailEnv: stringValue(target, "sub2apiAdminEmailEnv", `runtime.serverTargets.${id}`),
      sub2apiAdminPasswordEnv: stringValue(target, "sub2apiAdminPasswordEnv", `runtime.serverTargets.${id}`),
      webPasswordEnv: stringValue(target, "webPasswordEnv", `runtime.serverTargets.${id}`),
      apiKeyEnv: stringValue(target, "apiKeyEnv", `runtime.serverTargets.${id}`),
      sessionSecretEnv: stringValue(target, "sessionSecretEnv", `runtime.serverTargets.${id}`),
    };
  }
  const automaticMode = stringValue(automaticCredit, "mode", "lottery.automaticCredit");
  if (automaticMode !== "dry-run" && automaticMode !== "live") throw new Error("lottery.automaticCredit.mode must be dry-run or live");
  const defaultCliTarget = stringValue(runtime, "defaultCliTarget", "runtime");
  if (!cliTargets[defaultCliTarget]) throw new Error(`runtime.defaultCliTarget references missing target ${defaultCliTarget}`);
  return {
    apiVersion: stringValue(raw, "apiVersion", "config"),
    kind: stringValue(raw, "kind", "config"),
    metadata: { name: stringValue(metadata, "name", "metadata"), owner: stringValue(metadata, "owner", "metadata") },
    monitor: {
      timezone: timezoneValue(monitor, "timezone", "monitor"),
      refreshIntervalMinutes: integerValue(monitor, "refreshIntervalMinutes", "monitor", 1, 1440),
      scoreWindow: stringValue(monitor, "scoreWindow", "monitor"),
      target: stringValue(monitor, "target", "monitor"),
      cli: {
        workDir: stringValue(monitorCli, "workDir", "monitor.cli"),
        executable: stringValue(monitorCli, "executable", "monitor.cli"),
        entrypoint: stringValue(monitorCli, "entrypoint", "monitor.cli"),
        mainServerHost: stringValue(monitorCli, "mainServerHost", "monitor.cli"),
        timeoutMs: integerValue(monitorCli, "timeoutMs", "monitor.cli", 1000),
      },
    },
    webAuth: {
      username: stringValue(webAuth, "username", "webAuth"),
      cookieName: stringValue(webAuth, "cookieName", "webAuth"),
      sessionTtlSeconds: integerValue(webAuth, "sessionTtlSeconds", "webAuth", 300),
    },
    sub2api: {
      baseUrl: stringValue(sub2api, "baseUrl", "sub2api").replace(/\/$/u, ""),
      requestTimeoutMs: integerValue(sub2api, "requestTimeoutMs", "sub2api", 1),
      pageSize: integerValue(sub2api, "pageSize", "sub2api", 1, 100),
      adminCredentials: {
        sourceRef: stringValue(adminCredentials, "sourceRef", "sub2api.adminCredentials"),
        emailKey: stringValue(adminCredentials, "emailKey", "sub2api.adminCredentials"),
        passwordKey: stringValue(adminCredentials, "passwordKey", "sub2api.adminCredentials"),
      },
    },
    lottery: {
      timezone: timezoneValue(lottery, "timezone", "lottery"),
      initialDrawCount: integerValue(lottery, "initialDrawCount", "lottery"),
      dailyGrant: {
        hour: integerValue(dailyGrant, "hour", "lottery.dailyGrant", 0, 23),
        minute: integerValue(dailyGrant, "minute", "lottery.dailyGrant", 0, 59),
        count: integerValue(dailyGrant, "count", "lottery.dailyGrant", 1),
      },
      eligibility: {
        activeWithinHours: integerValue(eligibility, "activeWithinHours", "lottery.eligibility", 1),
        statuses: strings(eligibility, "statuses", "lottery.eligibility"),
        excludedRoles: strings(eligibility, "excludedRoles", "lottery.eligibility"),
        excludedIdentities: strings(eligibility, "excludedIdentities", "lottery.eligibility"),
        identityFields: identityFields(eligibility, "identityFields", "lottery.eligibility"),
      },
      prize: { amountUsd: numberValue(prize, "amountUsd", "lottery.prize", 0.01) },
      automaticCredit: {
        enabled: booleanValue(automaticCredit, "enabled", "lottery.automaticCredit"),
        mode: automaticMode,
        notesPrefix: stringValue(automaticCredit, "notesPrefix", "lottery.automaticCredit"),
      },
      creditTest: {
        targetIdentifier: stringValue(creditTest, "targetIdentifier", "lottery.creditTest"),
        identityFields: identityFields(creditTest, "identityFields", "lottery.creditTest"),
        amountUsd: numberValue(creditTest, "amountUsd", "lottery.creditTest", 0.01),
        notes: stringValue(creditTest, "notes", "lottery.creditTest"),
      },
    },
    ranking: {
      timezone: timezoneValue(ranking, "timezone", "ranking"),
      windowDays: integerValue(ranking, "windowDays", "ranking", 1),
      sourceLimit: integerValue(ranking, "sourceLimit", "ranking", 1),
      displayLimit: integerValue(ranking, "displayLimit", "ranking", 1),
    },
    records: { publicLimit: integerValue(records, "publicLimit", "records", 1) },
    runtime: {
      secretsRoot: stringValue(runtime, "secretsRoot", "runtime"),
      secretSourcePaths: Object.fromEntries(Object.entries(secretSourcePathsRaw).map(([ref, value]) => {
        if (typeof value !== "string" || value.trim() === "") throw new Error(`runtime.secretSourcePaths.${ref} must be a non-empty string`);
        return [ref, value];
      })),
      defaultCliTarget,
      cliTargets,
      serverTargets,
    },
    configPath,
    rootDirectory,
  };
}

export function resolveDataPath(config: AppConfig, value: string): string {
  return isAbsolute(value) ? value : resolve(config.rootDirectory, value);
}
