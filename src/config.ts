import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DateTime } from "luxon";
import { parse } from "yaml";

export type IdentityField = "username" | "email" | "emailLocalPart";

export interface SecretRef {
  sourceRef: string;
  sourceKey: string;
}

export interface EnvSecretRef {
  envKey: string;
}

export interface ScorePolicy {
  reliabilityWeight: number;
  failoverWeight: number;
  latencyWeight: number;
  baselineWeight: number;
  failureZeroScoreRate: number;
  failureBurstCallLimit: number;
  failoverZeroScoreRate: number;
  ttftFullScoreMs: number;
  ttftZeroScoreMs: number;
}

export interface PriorityPlanPolicy {
  platform: string;
  eligibleGroupIds: number[];
  requiredConfidence: string;
  requireCurrentAvailable: boolean;
  qualityWeight: number;
  costWeight: number;
  referenceScore: number;
  pointsPerScore: number;
  minimumChange: number;
  minimumPriority: number;
  maximumPriority: number;
  reservePolicies: Record<string, {
    lowRemainingThresholdPercent: number;
    unrestrictedRemainingThresholdPercent: number;
    lowRemainingPriority: number;
  }>;
  procurementAdvice: {
    enabled: boolean;
    minimumQualityScore: number;
    valueWeight: number;
    redundancyWeight: number;
    recommendationLimit: number;
    statusAlertLimit: number;
    maximumRecommendationsPerSupplier: number;
    minimumSupplierCount: number;
    maximumSupplierShare: number;
    billingErrorPatterns: string[];
  };
}

export interface AppConfig {
  apiVersion: string;
  kind: string;
  metadata: { name: string; owner: string };
  monitor: {
    timezone: string;
    refreshIntervalMinutes: number;
    automaticRefresh: {
      enabled: boolean;
    };
    recentCallLimit: number;
    errorAggregateLimit: number;
    errorAggregateTop: number;
    recentCallOptions: number[];
    target: string;
    cli: { workDir: string; executable: string; entrypoint: string; mainServerHost: string; timeoutMs: number };
  };
  webAuth: { username: string; cookieName: string; sessionTtlSeconds: number };
  sub2api: {
    baseUrl: string;
    requestTimeoutMs: number;
    pageSize: number;
    scoreDatabase: SecretRef & {
      statementTimeoutMs: number;
      queueTimeoutMs: number;
      cacheTtlMs: number;
      cacheMaxEntries: number;
    };
    scorePolicy: ScorePolicy;
    grokScorePolicy: ScorePolicy;
    priorityPlan: PriorityPlanPolicy;
    grokPriorityPlan: PriorityPlanPolicy;
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
  operations: {
    databaseUrlEnv: string;
    ledgerYamlPath: string;
    rechargeDenominationsCny: number[];
    planTtlMinutes: number;
    auditLimit: number;
    priorityVerificationTimeoutMs: number;
    priorityVerificationPollMs: number;
    automationPollMs: number;
    automationJitterPercent: number;
    automationSafety: {
      maximumScoreQueryDurationMs: number;
    };
    priorityWrite: {
      batchSize: number;
      interBatchMinimumDelayMs: number;
      interBatchMaximumDelayMs: number;
      maximumRetries: number;
      retryInitialDelayMs: number;
      retryJitterPercent: number;
    };
  };
  temporal: {
    addressEnv: string;
    namespace: string;
    taskQueue: string;
    scoreScheduleWorkflowId: string;
    workflowExecutionTimeout: string;
    activityStartToCloseTimeout: string;
    retry: { maximumAttempts: number };
  };
  runtime: {
    secretsRoot: string;
    secretSourcePaths: Record<string, string>;
    defaultCliTarget: string;
    overApiTarget: string;
    cliTargets: Record<string, EmbeddedCliTarget | HttpCliTarget>;
    native: {
      stateDir: string;
      env: Record<string, SecretRef>;
      temporalServiceRef: {
        executionPlane: "local-k3s" | "route";
        route: string;
        kubeconfig: string;
        namespace: string;
        service: string;
        portName: string;
      };
      services: Record<NativeServiceId, NativeServiceConfig>;
    };
    serverTargets: Record<string, ServerTarget>;
  };
  configPath: string;
  rootDirectory: string;
}

export interface EmbeddedCliTarget {
  mode: "embedded";
  databasePath: string;
  scoreCachePath: string;
  monitorWorkDir: string;
  temporalTaskQueue: string;
}

export interface HttpCliTarget {
  mode: "http";
  baseUrl: string;
  adminToken: SecretRef | EnvSecretRef;
}

export interface ServerTarget {
  listenHost: string;
  listenPort: number;
  workerHealthHost: string;
  workerHealthPort: number;
  webListenHost: string;
  webListenPort: number;
  webAllowedHosts: string[];
  webApiBaseUrl: string;
  secureCookies: boolean;
  databasePath: string;
  scoreCachePath: string;
  monitorWorkDir: string;
  temporalTaskQueue: string;
  scoreScheduleWorkflowId: string;
  adminTokenEnv: string;
  sub2apiAdminEmailEnv: string;
  sub2apiAdminPasswordEnv: string;
  scoreDatabaseUrlEnv: string;
  webPasswordEnv: string;
  apiKeyEnv: string;
  sessionSecretEnv: string;
}

export type NativeServiceId = "api" | "worker" | "web";

export interface NativeServiceConfig {
  envKeys: string[];
  command: string[];
  pidFile: string;
  logFile: string;
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

function numberValue(
  parent: ObjectValue,
  key: string,
  path: string,
  minimum = 0,
  maximum = Number.MAX_VALUE,
): number {
  const value = parent[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${path}.${key} must be a number from ${minimum} to ${maximum}`);
  }
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

function integers(parent: ObjectValue, key: string, path: string, minimum: number, maximum: number): number[] {
  const value = parent[key];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${path}.${key} must be a non-empty integer array`);
  const result = value.map((item, index) => {
    if (!Number.isInteger(item) || Number(item) < minimum || Number(item) > maximum) {
      throw new Error(`${path}.${key}[${index}] must be an integer from ${minimum} to ${maximum}`);
    }
    return Number(item);
  });
  if (new Set(result).size !== result.length) throw new Error(`${path}.${key} must not contain duplicates`);
  return result;
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

function cliTokenRef(value: unknown, path: string): SecretRef | EnvSecretRef {
  const raw = object(value, path);
  if (typeof raw.envKey === "string") {
    if (raw.sourceRef !== undefined || raw.sourceKey !== undefined) throw new Error(`${path} must use either envKey or sourceRef/sourceKey`);
    return { envKey: stringValue(raw, "envKey", path) };
  }
  return secretRef(raw, path);
}

function nativeFile(parent: ObjectValue, key: string, path: string): string {
  const value = stringValue(parent, key, path);
  if (value.includes("/") || value.includes("\\") || value === "." || value === "..") throw new Error(`${path}.${key} must be a filename`);
  return value;
}

function readScorePolicy(raw: unknown, path: string): ScorePolicy {
  const policy = object(raw, path);
  return {
    reliabilityWeight: numberValue(policy, "reliabilityWeight", path, 0, 100),
    failoverWeight: numberValue(policy, "failoverWeight", path, 0, 100),
    latencyWeight: numberValue(policy, "latencyWeight", path, 0, 100),
    baselineWeight: numberValue(policy, "baselineWeight", path, 0, 100),
    failureZeroScoreRate: numberValue(policy, "failureZeroScoreRate", path, 0.000001, 1),
    failureBurstCallLimit: integerValue(policy, "failureBurstCallLimit", path, 1),
    failoverZeroScoreRate: numberValue(policy, "failoverZeroScoreRate", path, 0.000001, 1),
    ttftFullScoreMs: integerValue(policy, "ttftFullScoreMs", path, 0),
    ttftZeroScoreMs: integerValue(policy, "ttftZeroScoreMs", path, 1),
  };
}

function readPriorityPlanPolicy(raw: unknown, path: string): PriorityPlanPolicy {
  const policy = object(raw, path);
  const reserveRaw = object(policy.reservePolicies, `${path}.reservePolicies`);
  const reservePolicies = Object.fromEntries(Object.keys(reserveRaw).map((accountId) => {
    if (!/^[1-9][0-9]*$/u.test(accountId)) throw new Error(`${path}.reservePolicies keys must be positive account IDs`);
    const itemPath = `${path}.reservePolicies.${accountId}`;
    const item = object(reserveRaw[accountId], itemPath);
    const lowRemainingThresholdPercent = numberValue(item, "lowRemainingThresholdPercent", itemPath, 0, 100);
    const unrestrictedRemainingThresholdPercent = numberValue(item, "unrestrictedRemainingThresholdPercent", itemPath, 0, 100);
    if (unrestrictedRemainingThresholdPercent <= lowRemainingThresholdPercent) {
      throw new Error(`${itemPath}.unrestrictedRemainingThresholdPercent must be greater than lowRemainingThresholdPercent`);
    }
    return [accountId, {
      lowRemainingThresholdPercent,
      unrestrictedRemainingThresholdPercent,
      lowRemainingPriority: integerValue(item, "lowRemainingPriority", itemPath, 1, 1000),
    }];
  }));
  const advicePath = `${path}.procurementAdvice`;
  const advice = object(policy.procurementAdvice, advicePath);
  return {
    platform: stringValue(policy, "platform", path),
    eligibleGroupIds: integers(policy, "eligibleGroupIds", path, 1, Number.MAX_SAFE_INTEGER),
    requiredConfidence: stringValue(policy, "requiredConfidence", path),
    requireCurrentAvailable: booleanValue(policy, "requireCurrentAvailable", path),
    qualityWeight: numberValue(policy, "qualityWeight", path, 0, 100),
    costWeight: numberValue(policy, "costWeight", path, 0, 100),
    referenceScore: numberValue(policy, "referenceScore", path, 0, 100),
    pointsPerScore: numberValue(policy, "pointsPerScore", path, 0.01, 1000),
    minimumChange: integerValue(policy, "minimumChange", path, 1, 1000),
    minimumPriority: integerValue(policy, "minimumPriority", path, 1, 1000),
    maximumPriority: integerValue(policy, "maximumPriority", path, 1, 1000),
    reservePolicies,
    procurementAdvice: {
      enabled: booleanValue(advice, "enabled", advicePath),
      minimumQualityScore: numberValue(advice, "minimumQualityScore", advicePath, 0, 100),
      valueWeight: numberValue(advice, "valueWeight", advicePath, 0, 100),
      redundancyWeight: numberValue(advice, "redundancyWeight", advicePath, 0, 100),
      recommendationLimit: integerValue(advice, "recommendationLimit", advicePath, 1, 100),
      statusAlertLimit: integerValue(advice, "statusAlertLimit", advicePath, 1, 100),
      maximumRecommendationsPerSupplier: integerValue(advice, "maximumRecommendationsPerSupplier", advicePath, 1, 100),
      minimumSupplierCount: integerValue(advice, "minimumSupplierCount", advicePath, 1, 100),
      maximumSupplierShare: numberValue(advice, "maximumSupplierShare", advicePath, 0.01, 1),
      billingErrorPatterns: strings(advice, "billingErrorPatterns", advicePath),
    },
  };
}

export function loadConfig(path: string): AppConfig {
  const configPath = resolve(path);
  const rootDirectory = resolve(dirname(configPath), "..");
  const raw = object(parse(readFileSync(configPath, "utf8")), "config");
  const metadata = object(raw.metadata, "metadata");
  const sub2api = object(raw.sub2api, "sub2api");
  const monitor = object(raw.monitor, "monitor");
  const automaticRefresh = object(monitor.automaticRefresh, "monitor.automaticRefresh");
  const monitorCli = object(monitor.cli, "monitor.cli");
  const webAuth = object(raw.webAuth, "webAuth");
  const adminCredentials = object(sub2api.adminCredentials, "sub2api.adminCredentials");
  const scoreDatabase = object(sub2api.scoreDatabase, "sub2api.scoreDatabase");
  const lottery = object(raw.lottery, "lottery");
  const dailyGrant = object(lottery.dailyGrant, "lottery.dailyGrant");
  const eligibility = object(lottery.eligibility, "lottery.eligibility");
  const prize = object(lottery.prize, "lottery.prize");
  const automaticCredit = object(lottery.automaticCredit, "lottery.automaticCredit");
  const creditTest = object(lottery.creditTest, "lottery.creditTest");
  const ranking = object(raw.ranking, "ranking");
  const records = object(raw.records, "records");
  const operations = object(raw.operations, "operations");
  const automationSafety = object(operations.automationSafety, "operations.automationSafety");
  const priorityWrite = object(operations.priorityWrite, "operations.priorityWrite");
  const interBatchMinimumDelayMs = integerValue(
    priorityWrite,
    "interBatchMinimumDelayMs",
    "operations.priorityWrite",
    0,
    120000,
  );
  const interBatchMaximumDelayMs = integerValue(
    priorityWrite,
    "interBatchMaximumDelayMs",
    "operations.priorityWrite",
    0,
    120000,
  );
  if (interBatchMaximumDelayMs < interBatchMinimumDelayMs) {
    throw new Error("operations.priorityWrite.interBatchMaximumDelayMs must be >= interBatchMinimumDelayMs");
  }
  const temporal = object(raw.temporal, "temporal");
  const temporalRetry = object(temporal.retry, "temporal.retry");
  const runtime = object(raw.runtime, "runtime");
  const native = object(runtime.native, "runtime.native");
  const nativeServicesRaw = object(native.services, "runtime.native.services");
  const nativeEnvRaw = object(native.env, "runtime.native.env");
  const nativeTemporalServiceRef = object(native.temporalServiceRef, "runtime.native.temporalServiceRef");
  const nativeTemporalExecutionPlane = stringValue(
    nativeTemporalServiceRef,
    "executionPlane",
    "runtime.native.temporalServiceRef",
  );
  if (
    nativeTemporalExecutionPlane !== "local-k3s"
    && nativeTemporalExecutionPlane !== "route"
  ) {
    throw new Error(
      "runtime.native.temporalServiceRef.executionPlane must be local-k3s or route",
    );
  }
  const secretSourcePathsRaw = object(runtime.secretSourcePaths, "runtime.secretSourcePaths");
  const cliTargetsRaw = object(runtime.cliTargets, "runtime.cliTargets");
  const serverTargetsRaw = object(runtime.serverTargets, "runtime.serverTargets");
  const cliTargets: Record<string, EmbeddedCliTarget | HttpCliTarget> = {};
  for (const [id, value] of Object.entries(cliTargetsRaw)) {
    const target = object(value, `runtime.cliTargets.${id}`);
    const mode = stringValue(target, "mode", `runtime.cliTargets.${id}`);
    if (mode === "embedded") cliTargets[id] = {
      mode,
      databasePath: stringValue(target, "databasePath", `runtime.cliTargets.${id}`),
      scoreCachePath: stringValue(target, "scoreCachePath", `runtime.cliTargets.${id}`),
      monitorWorkDir: stringValue(target, "monitorWorkDir", `runtime.cliTargets.${id}`),
      temporalTaskQueue: stringValue(target, "temporalTaskQueue", `runtime.cliTargets.${id}`),
    };
    else if (mode === "http") cliTargets[id] = { mode, baseUrl: stringValue(target, "baseUrl", `runtime.cliTargets.${id}`), adminToken: cliTokenRef(target.adminToken, `runtime.cliTargets.${id}.adminToken`) };
    else throw new Error(`runtime.cliTargets.${id}.mode must be embedded or http`);
  }
  const serverTargets: Record<string, ServerTarget> = {};
  for (const [id, value] of Object.entries(serverTargetsRaw)) {
    const target = object(value, `runtime.serverTargets.${id}`);
    serverTargets[id] = {
      listenHost: stringValue(target, "listenHost", `runtime.serverTargets.${id}`),
      listenPort: numberValue(target, "listenPort", `runtime.serverTargets.${id}`, 1),
      workerHealthHost: stringValue(target, "workerHealthHost", `runtime.serverTargets.${id}`),
      workerHealthPort: numberValue(target, "workerHealthPort", `runtime.serverTargets.${id}`, 1),
      webListenHost: stringValue(target, "webListenHost", `runtime.serverTargets.${id}`),
      webListenPort: numberValue(target, "webListenPort", `runtime.serverTargets.${id}`, 1),
      webAllowedHosts: strings(target, "webAllowedHosts", `runtime.serverTargets.${id}`),
      webApiBaseUrl: stringValue(target, "webApiBaseUrl", `runtime.serverTargets.${id}`),
      secureCookies: booleanValue(target, "secureCookies", `runtime.serverTargets.${id}`),
      databasePath: stringValue(target, "databasePath", `runtime.serverTargets.${id}`),
      scoreCachePath: stringValue(target, "scoreCachePath", `runtime.serverTargets.${id}`),
      monitorWorkDir: stringValue(target, "monitorWorkDir", `runtime.serverTargets.${id}`),
      temporalTaskQueue: stringValue(target, "temporalTaskQueue", `runtime.serverTargets.${id}`),
      scoreScheduleWorkflowId: stringValue(target, "scoreScheduleWorkflowId", `runtime.serverTargets.${id}`),
      adminTokenEnv: stringValue(target, "adminTokenEnv", `runtime.serverTargets.${id}`),
      sub2apiAdminEmailEnv: stringValue(target, "sub2apiAdminEmailEnv", `runtime.serverTargets.${id}`),
      sub2apiAdminPasswordEnv: stringValue(target, "sub2apiAdminPasswordEnv", `runtime.serverTargets.${id}`),
      scoreDatabaseUrlEnv: stringValue(target, "scoreDatabaseUrlEnv", `runtime.serverTargets.${id}`),
      webPasswordEnv: stringValue(target, "webPasswordEnv", `runtime.serverTargets.${id}`),
      apiKeyEnv: stringValue(target, "apiKeyEnv", `runtime.serverTargets.${id}`),
      sessionSecretEnv: stringValue(target, "sessionSecretEnv", `runtime.serverTargets.${id}`),
    };
  }
  const automaticMode = stringValue(automaticCredit, "mode", "lottery.automaticCredit");
  if (automaticMode !== "dry-run" && automaticMode !== "live") throw new Error("lottery.automaticCredit.mode must be dry-run or live");
  const defaultCliTarget = stringValue(runtime, "defaultCliTarget", "runtime");
  if (!cliTargets[defaultCliTarget]) throw new Error(`runtime.defaultCliTarget references missing target ${defaultCliTarget}`);
  const overApiTarget = stringValue(runtime, "overApiTarget", "runtime");
  if (cliTargets[overApiTarget]?.mode !== "http") throw new Error(`runtime.overApiTarget must reference an http target`);
  const nativeServices = {} as Record<NativeServiceId, NativeServiceConfig>;
  for (const id of ["api", "worker", "web"] as const) {
    const service = object(nativeServicesRaw[id], `runtime.native.services.${id}`);
    const envKeys = strings(service, "envKeys", `runtime.native.services.${id}`);
    const supportedEnvKeys = new Set([
      ...Object.keys(nativeEnvRaw),
      stringValue(temporal, "addressEnv", "temporal"),
    ]);
    for (const envKey of envKeys) {
      if (!supportedEnvKeys.has(envKey)) {
        throw new Error(`runtime.native.services.${id}.envKeys contains undeclared key ${envKey}`);
      }
    }
    const command = strings(service, "command", `runtime.native.services.${id}`);
    if (command.length === 0) throw new Error(`runtime.native.services.${id}.command must not be empty`);
    nativeServices[id] = {
      envKeys,
      command,
      pidFile: nativeFile(service, "pidFile", `runtime.native.services.${id}`),
      logFile: nativeFile(service, "logFile", `runtime.native.services.${id}`),
    };
  }
  return {
    apiVersion: stringValue(raw, "apiVersion", "config"),
    kind: stringValue(raw, "kind", "config"),
    metadata: { name: stringValue(metadata, "name", "metadata"), owner: stringValue(metadata, "owner", "metadata") },
    monitor: {
      timezone: timezoneValue(monitor, "timezone", "monitor"),
      refreshIntervalMinutes: integerValue(monitor, "refreshIntervalMinutes", "monitor", 1, 1440),
      automaticRefresh: {
        enabled: booleanValue(automaticRefresh, "enabled", "monitor.automaticRefresh"),
      },
      recentCallLimit: integerValue(monitor, "recentCallLimit", "monitor", 1, 10000),
      errorAggregateLimit: integerValue(monitor, "errorAggregateLimit", "monitor", 1, 10000),
      errorAggregateTop: integerValue(monitor, "errorAggregateTop", "monitor", 1, 100),
      recentCallOptions: integers(monitor, "recentCallOptions", "monitor", 1, 10000),
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
      scoreDatabase: {
        sourceRef: stringValue(scoreDatabase, "sourceRef", "sub2api.scoreDatabase"),
        sourceKey: stringValue(scoreDatabase, "sourceKey", "sub2api.scoreDatabase"),
        statementTimeoutMs: integerValue(scoreDatabase, "statementTimeoutMs", "sub2api.scoreDatabase", 1000, 60000),
        queueTimeoutMs: integerValue(scoreDatabase, "queueTimeoutMs", "sub2api.scoreDatabase", 1000, 120000),
        cacheTtlMs: integerValue(scoreDatabase, "cacheTtlMs", "sub2api.scoreDatabase", 0, 60000),
        cacheMaxEntries: integerValue(scoreDatabase, "cacheMaxEntries", "sub2api.scoreDatabase", 1, 1000),
      },
      scorePolicy: readScorePolicy(sub2api.scorePolicy, "sub2api.scorePolicy"),
      grokScorePolicy: readScorePolicy(sub2api.grokScorePolicy, "sub2api.grokScorePolicy"),
      priorityPlan: readPriorityPlanPolicy(sub2api.priorityPlan, "sub2api.priorityPlan"),
      grokPriorityPlan: readPriorityPlanPolicy(sub2api.grokPriorityPlan, "sub2api.grokPriorityPlan"),
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
    operations: {
      databaseUrlEnv: stringValue(operations, "databaseUrlEnv", "operations"),
      ledgerYamlPath: stringValue(operations, "ledgerYamlPath", "operations"),
      rechargeDenominationsCny: integers(operations, "rechargeDenominationsCny", "operations", 1, 100000),
      planTtlMinutes: integerValue(operations, "planTtlMinutes", "operations", 1, 1440),
      auditLimit: integerValue(operations, "auditLimit", "operations", 1, 1000),
      priorityVerificationTimeoutMs: integerValue(operations, "priorityVerificationTimeoutMs", "operations", 1000, 120000),
      priorityVerificationPollMs: integerValue(operations, "priorityVerificationPollMs", "operations", 100, 10000),
      automationPollMs: integerValue(operations, "automationPollMs", "operations", 100, 60000),
      automationJitterPercent: numberValue(operations, "automationJitterPercent", "operations", 0, 0.5),
      automationSafety: {
        maximumScoreQueryDurationMs: integerValue(
          automationSafety,
          "maximumScoreQueryDurationMs",
          "operations.automationSafety",
          100,
          120000,
        ),
      },
      priorityWrite: {
        batchSize: integerValue(priorityWrite, "batchSize", "operations.priorityWrite", 1, 100),
        interBatchMinimumDelayMs,
        interBatchMaximumDelayMs,
        maximumRetries: integerValue(priorityWrite, "maximumRetries", "operations.priorityWrite", 0, 3),
        retryInitialDelayMs: integerValue(
          priorityWrite,
          "retryInitialDelayMs",
          "operations.priorityWrite",
          100,
          120000,
        ),
        retryJitterPercent: numberValue(
          priorityWrite,
          "retryJitterPercent",
          "operations.priorityWrite",
          0,
          0.5,
        ),
      },
    },
    temporal: {
      addressEnv: stringValue(temporal, "addressEnv", "temporal"),
      namespace: stringValue(temporal, "namespace", "temporal"),
      taskQueue: stringValue(temporal, "taskQueue", "temporal"),
      scoreScheduleWorkflowId: stringValue(temporal, "scoreScheduleWorkflowId", "temporal"),
      workflowExecutionTimeout: stringValue(temporal, "workflowExecutionTimeout", "temporal"),
      activityStartToCloseTimeout: stringValue(temporal, "activityStartToCloseTimeout", "temporal"),
      retry: { maximumAttempts: integerValue(temporalRetry, "maximumAttempts", "temporal.retry", 1) },
    },
    runtime: {
      secretsRoot: stringValue(runtime, "secretsRoot", "runtime"),
      secretSourcePaths: Object.fromEntries(Object.entries(secretSourcePathsRaw).map(([ref, value]) => {
        if (typeof value !== "string" || value.trim() === "") throw new Error(`runtime.secretSourcePaths.${ref} must be a non-empty string`);
        return [ref, value];
      })),
      defaultCliTarget,
      overApiTarget,
      cliTargets,
      native: {
        stateDir: stringValue(native, "stateDir", "runtime.native"),
        env: Object.fromEntries(Object.entries(nativeEnvRaw).map(([targetKey, value]) => [targetKey, secretRef(value, `runtime.native.env.${targetKey}`)])),
        temporalServiceRef: {
          executionPlane: nativeTemporalExecutionPlane,
          route: stringValue(nativeTemporalServiceRef, "route", "runtime.native.temporalServiceRef"),
          kubeconfig: stringValue(nativeTemporalServiceRef, "kubeconfig", "runtime.native.temporalServiceRef"),
          namespace: stringValue(nativeTemporalServiceRef, "namespace", "runtime.native.temporalServiceRef"),
          service: stringValue(nativeTemporalServiceRef, "service", "runtime.native.temporalServiceRef"),
          portName: stringValue(nativeTemporalServiceRef, "portName", "runtime.native.temporalServiceRef"),
        },
        services: nativeServices,
      },
      serverTargets,
    },
    configPath,
    rootDirectory,
  };
}

export function resolveDataPath(config: AppConfig, value: string): string {
  return isAbsolute(value) ? value : resolve(config.rootDirectory, value);
}
