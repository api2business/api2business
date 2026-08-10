import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DateTime } from "luxon";
import { parse } from "yaml";
import { validateFailoverRules, type FailoverRule } from "./failover-rules";

export type IdentityField = "username" | "email" | "emailLocalPart";
export type OAuthPlanType = "k12" | "plus" | "free" | "team";
export type OAuthIdealApiUsdPerAccount = Record<OAuthPlanType, number>;

export interface UpstreamManagementConfig {
  pageSize: number;
  defaultTemplate: string;
  primaryGroupId: number;
  groupIds: number[];
  priority: number;
  capacity: number;
  proxyId: number;
  createBootstrapRateCnyPerApiUsd: number;
  unprobedFallbackRateCnyPerApiUsd: number;
  mutationTimeoutMs: number;
  usageConcurrency: number;
  usageTimeoutMs: number;
  usageDays: number;
  quotaSampleIntervalSeconds: number;
  quotaSampleTimeoutSeconds: number;
  rechargeCandidates: {
    lowBalanceCny: number;
    lookbackHours: number;
    recommendationLimit: number;
    retiredSuppliers: string[];
  };
  failoverRules: FailoverRule[];
}

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
  explorationWeight: number;
  explorationTargetAttempts: number;
  explorationQualityPrior: number;
  balanceWeight: number;
  dynamicQualityFeedback: {
    targetQualityScore: number;
    coefficient: number;
  };
  referenceScore: number;
  pointsPerScore: number;
  minimumChange: number;
  normalizationTopK: number;
  minimumPriorityUniformity: number;
  minimumPriority: number;
  maximumPriority: number;
  fixedPriorities: Record<string, number>;
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
    poolScorePolicy: ScorePolicy;
    grokScorePolicy: ScorePolicy;
    scoreSamplePolicy: {
      retentionHours: number;
      decayBucketSize: number;
      decayStep: number;
      minimumWeight: number;
    };
    idleProbe: {
      enabled: boolean;
      intervalSeconds: number;
      idleSeconds: number;
      model: string;
      reasoningEffort: "low" | "medium" | "high";
      candidateLimit: number;
      concurrency: number;
      accountTimeoutMs: number;
      requestJitterMinMs: number;
      requestJitterMaxMs: number;
      roundTimeoutSeconds: number;
      provisionCandidateLimit: number;
      provisionTimeoutSeconds: number;
      isolation: {
        enabled: boolean;
        gatewayBaseUrl: string;
        groupNamePrefix: string;
        groupRateMultiplier: number;
        userBalance: number;
        secretFile: string;
      };
    };
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
    accountImportLedgerPath: string;
    upstreamRechargeLedgerPath: string;
    accountLifecycleLedgerPath: string;
    accountImportArchiveDirectory: string;
    accountLifecycle: {
      defaultModel: string;
      testBatchSize: number;
      testTimeoutMs: number;
      deleteTimeoutMs: number;
      deleteBatchSize: number;
    };
    accountImportDefaults: {
      priority: number;
      capacity: number;
      importTimeoutMs: number;
      groupIds: number[];
      sourceProxyId: number;
      perAccountProxy: boolean;
      planType: OAuthPlanType;
      freeCostThresholdCny: number;
      plusCostThresholdCny: number;
    };
    upstreamManagement: UpstreamManagementConfig;
    upstreamBenchmark: {
      enabled: boolean;
      provider: string;
      benchmarkVersion: string;
      model: string;
      requestTimeoutMs: number;
    };
    oauthEconomics: {
      excludedAccountIds: number[];
      idealApiUsdPerAccount: OAuthIdealApiUsdPerAccount;
    };
    rechargeDenominationsCny: number[];
    planTtlMinutes: number;
    auditLimit: number;
    priorityVerificationTimeoutMs: number;
    priorityVerificationPollMs: number;
    automationPollMs: number;
    automationRunTimeoutMs: number;
    automationFailureBackoffMaxMs: number;
    automationFailureRetryLimit: number;
    automationFailureCooldownMs: number;
    automationJitterPercent: number;
    automationSafety: {
      maximumScoreQueryDurationMs: number;
    };
    priorityWrite: {
      batchSize: number;
      requestTimeoutMs: number;
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
    submissionTimeoutMs: number;
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
      mode: "native" | "docker-compose";
      composeFile: string;
      composeProject: string;
      composeEnvFile: string;
      stateDir: string;
      env: Record<string, SecretRef>;
      temporalServiceRef: {
        executionPlane: "local-k3s" | "route";
        route: string;
        kubeconfig: string;
        namespace: string;
        service: string;
        portName: string;
        resolutionTimeoutMs: number;
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
  const dynamicQualityFeedback = object(policy.dynamicQualityFeedback, `${path}.dynamicQualityFeedback`);
  const fixedRaw = object(policy.fixedPriorities, `${path}.fixedPriorities`);
  const fixedPriorities = Object.fromEntries(Object.keys(fixedRaw).map((accountId) => {
    if (!/^[1-9][0-9]*$/u.test(accountId)) throw new Error(`${path}.fixedPriorities keys must be positive account IDs`);
    return [accountId, integerValue(fixedRaw, accountId, `${path}.fixedPriorities`, 1, 1000)];
  }));
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
  const overlappingAccountIds = Object.keys(fixedPriorities).filter((accountId) => reservePolicies[accountId] !== undefined);
  if (overlappingAccountIds.length > 0) {
    throw new Error(`${path} accounts cannot use both fixedPriorities and reservePolicies: ${overlappingAccountIds.join(",")}`);
  }
  const advicePath = `${path}.procurementAdvice`;
  const advice = object(policy.procurementAdvice, advicePath);
  return {
    platform: stringValue(policy, "platform", path),
    eligibleGroupIds: integers(policy, "eligibleGroupIds", path, 1, Number.MAX_SAFE_INTEGER),
    requiredConfidence: stringValue(policy, "requiredConfidence", path),
    requireCurrentAvailable: booleanValue(policy, "requireCurrentAvailable", path),
    qualityWeight: numberValue(policy, "qualityWeight", path, 0, 100),
    costWeight: numberValue(policy, "costWeight", path, 0, 100),
    explorationWeight: numberValue(policy, "explorationWeight", path, 0, 100),
    explorationTargetAttempts: integerValue(policy, "explorationTargetAttempts", path, 1, 10000),
    explorationQualityPrior: numberValue(policy, "explorationQualityPrior", path, 0, 100),
    balanceWeight: numberValue(policy, "balanceWeight", path, 0, 100),
    dynamicQualityFeedback: {
      targetQualityScore: numberValue(dynamicQualityFeedback, "targetQualityScore", `${path}.dynamicQualityFeedback`, 0, 100),
      coefficient: numberValue(dynamicQualityFeedback, "coefficient", `${path}.dynamicQualityFeedback`, 0, 10),
    },
    referenceScore: numberValue(policy, "referenceScore", path, 0, 100),
    pointsPerScore: numberValue(policy, "pointsPerScore", path, 0.01, 1000),
    minimumChange: integerValue(policy, "minimumChange", path, 1, 1000),
    normalizationTopK: integerValue(policy, "normalizationTopK", path, 2, 10000),
    minimumPriorityUniformity: numberValue(policy, "minimumPriorityUniformity", path, 0, 1),
    minimumPriority: integerValue(policy, "minimumPriority", path, 1, 1000),
    maximumPriority: integerValue(policy, "maximumPriority", path, 1, 1000),
    fixedPriorities,
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
  const scoreSamplePolicy = object(sub2api.scoreSamplePolicy, "sub2api.scoreSamplePolicy");
  const idleProbe = object(sub2api.idleProbe, "sub2api.idleProbe");
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
  const accountLifecycle = object(operations.accountLifecycle, "operations.accountLifecycle");
  const accountImportDefaults = object(operations.accountImportDefaults, "operations.accountImportDefaults");
  const upstreamManagement = object(operations.upstreamManagement, "operations.upstreamManagement");
  const upstreamBenchmark = object(operations.upstreamBenchmark, "operations.upstreamBenchmark");
  const upstreamFailoverRulesValue = upstreamManagement.failoverRules;
  if (!Array.isArray(upstreamFailoverRulesValue) || upstreamFailoverRulesValue.length === 0) {
    throw new Error("operations.upstreamManagement.failoverRules must be a non-empty array");
  }
  const upstreamFailoverRules: FailoverRule[] = upstreamFailoverRulesValue.map((value, index) => {
    const rule = object(value, `operations.upstreamManagement.failoverRules[${index}]`);
    return {
      error_code: integerValue(rule, "errorCode", `operations.upstreamManagement.failoverRules[${index}]`, 100, 599),
      keywords: strings(rule, "keywords", `operations.upstreamManagement.failoverRules[${index}]`),
      duration_minutes: integerValue(rule, "durationMinutes", `operations.upstreamManagement.failoverRules[${index}]`, 1, 60),
      description: stringValue(rule, "description", `operations.upstreamManagement.failoverRules[${index}]`),
    };
  });
  validateFailoverRules(upstreamFailoverRules);
  const upstreamGroupIds = integers(upstreamManagement, "groupIds", "operations.upstreamManagement", 1, Number.MAX_SAFE_INTEGER);
  const upstreamPrimaryGroupId = integerValue(upstreamManagement, "primaryGroupId", "operations.upstreamManagement", 1);
  if (!upstreamGroupIds.includes(upstreamPrimaryGroupId)) {
    throw new Error("operations.upstreamManagement.primaryGroupId must be included in groupIds");
  }
  const quotaSampleIntervalSeconds = integerValue(
    upstreamManagement, "quotaSampleIntervalSeconds", "operations.upstreamManagement", 60, 86400,
  );
  const quotaSampleTimeoutSeconds = integerValue(
    upstreamManagement, "quotaSampleTimeoutSeconds", "operations.upstreamManagement", 30, 3600,
  );
  if (quotaSampleTimeoutSeconds >= quotaSampleIntervalSeconds) {
    throw new Error("operations.upstreamManagement.quotaSampleTimeoutSeconds must be less than quotaSampleIntervalSeconds");
  }
  const oauthEconomics = object(operations.oauthEconomics, "operations.oauthEconomics");
  const idealApiUsdPerAccount = object(
    oauthEconomics.idealApiUsdPerAccount,
    "operations.oauthEconomics.idealApiUsdPerAccount",
  );
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
  const nativeMode = stringValue(native, "mode", "runtime.native");
  if (nativeMode !== "native" && nativeMode !== "docker-compose") throw new Error("runtime.native.mode must be native or docker-compose");
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
      poolScorePolicy: readScorePolicy(sub2api.poolScorePolicy, "sub2api.poolScorePolicy"),
      grokScorePolicy: readScorePolicy(sub2api.grokScorePolicy, "sub2api.grokScorePolicy"),
      scoreSamplePolicy: {
        retentionHours: integerValue(scoreSamplePolicy, "retentionHours", "sub2api.scoreSamplePolicy", 1, 168),
        decayBucketSize: integerValue(scoreSamplePolicy, "decayBucketSize", "sub2api.scoreSamplePolicy", 1, 1000),
        decayStep: numberValue(scoreSamplePolicy, "decayStep", "sub2api.scoreSamplePolicy", 0.000001, 1),
        minimumWeight: numberValue(scoreSamplePolicy, "minimumWeight", "sub2api.scoreSamplePolicy", 0.000001, 1),
      },
      idleProbe: (() => {
        const requestJitterMinMs = integerValue(idleProbe, "requestJitterMinMs", "sub2api.idleProbe", 0, 60000);
        const requestJitterMaxMs = integerValue(idleProbe, "requestJitterMaxMs", "sub2api.idleProbe", 0, 60000);
        if (requestJitterMaxMs < requestJitterMinMs) {
          throw new Error("sub2api.idleProbe.requestJitterMaxMs must be greater than or equal to requestJitterMinMs");
        }
        const reasoningEffort = stringValue(idleProbe, "reasoningEffort", "sub2api.idleProbe");
        if (!["low", "medium", "high"].includes(reasoningEffort)) {
          throw new Error("sub2api.idleProbe.reasoningEffort must be low, medium, or high");
        }
        return {
          enabled: booleanValue(idleProbe, "enabled", "sub2api.idleProbe"),
          intervalSeconds: integerValue(idleProbe, "intervalSeconds", "sub2api.idleProbe", 10, 3600),
          idleSeconds: integerValue(idleProbe, "idleSeconds", "sub2api.idleProbe", 10, 86400),
          model: stringValue(idleProbe, "model", "sub2api.idleProbe"),
          reasoningEffort: reasoningEffort as "low" | "medium" | "high",
          candidateLimit: integerValue(idleProbe, "candidateLimit", "sub2api.idleProbe", 1, 100),
          concurrency: integerValue(idleProbe, "concurrency", "sub2api.idleProbe", 1, 1000),
          accountTimeoutMs: integerValue(idleProbe, "accountTimeoutMs", "sub2api.idleProbe", 1000, 120000),
          requestJitterMinMs,
          requestJitterMaxMs,
          roundTimeoutSeconds: integerValue(idleProbe, "roundTimeoutSeconds", "sub2api.idleProbe", 5, 300),
          provisionCandidateLimit: integerValue(idleProbe, "provisionCandidateLimit", "sub2api.idleProbe", 1, 20),
          provisionTimeoutSeconds: integerValue(idleProbe, "provisionTimeoutSeconds", "sub2api.idleProbe", 10, 300),
          isolation: (() => {
            const value = object(idleProbe.isolation, "sub2api.idleProbe.isolation");
            const gatewayBaseUrl = stringValue(value, "gatewayBaseUrl", "sub2api.idleProbe.isolation").replace(/\/$/u, "");
            const parsedGatewayBaseUrl = new URL(gatewayBaseUrl);
            if (parsedGatewayBaseUrl.protocol !== "https:" || parsedGatewayBaseUrl.username || parsedGatewayBaseUrl.password) {
              throw new Error("sub2api.idleProbe.isolation.gatewayBaseUrl must be an HTTPS URL without credentials");
            }
            const groupNamePrefix = stringValue(value, "groupNamePrefix", "sub2api.idleProbe.isolation");
            if (!/^[a-z][a-z0-9-]{2,48}-$/u.test(groupNamePrefix)) {
              throw new Error("sub2api.idleProbe.isolation.groupNamePrefix must be an internal lowercase prefix ending with '-'");
            }
            const secretFile = stringValue(value, "secretFile", "sub2api.idleProbe.isolation");
            if (secretFile.includes("..") || !secretFile.startsWith(".state/")) {
              throw new Error("sub2api.idleProbe.isolation.secretFile must remain under .state");
            }
            return {
              enabled: booleanValue(value, "enabled", "sub2api.idleProbe.isolation"),
              gatewayBaseUrl,
              groupNamePrefix,
              groupRateMultiplier: numberValue(value, "groupRateMultiplier", "sub2api.idleProbe.isolation", 0.0001, 1),
              userBalance: numberValue(value, "userBalance", "sub2api.idleProbe.isolation", 0.000001, 10000),
              secretFile,
            };
          })(),
        };
      })(),
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
      accountImportLedgerPath: stringValue(operations, "accountImportLedgerPath", "operations"),
      upstreamRechargeLedgerPath: stringValue(operations, "upstreamRechargeLedgerPath", "operations"),
      accountLifecycleLedgerPath: stringValue(operations, "accountLifecycleLedgerPath", "operations"),
      accountImportArchiveDirectory: stringValue(operations, "accountImportArchiveDirectory", "operations"),
      accountLifecycle: {
        defaultModel: stringValue(accountLifecycle, "defaultModel", "operations.accountLifecycle"),
        testBatchSize: integerValue(accountLifecycle, "testBatchSize", "operations.accountLifecycle", 1, 20),
        testTimeoutMs: integerValue(accountLifecycle, "testTimeoutMs", "operations.accountLifecycle", 1000, 3600000),
        deleteTimeoutMs: integerValue(accountLifecycle, "deleteTimeoutMs", "operations.accountLifecycle", 1000, 3600000),
        deleteBatchSize: integerValue(accountLifecycle, "deleteBatchSize", "operations.accountLifecycle", 1, 100),
      },
      accountImportDefaults: {
        priority: integerValue(accountImportDefaults, "priority", "operations.accountImportDefaults", 1, 1000),
        capacity: integerValue(accountImportDefaults, "capacity", "operations.accountImportDefaults", 1, 100000),
        importTimeoutMs: integerValue(accountImportDefaults, "importTimeoutMs", "operations.accountImportDefaults", 1000, 600000),
        groupIds: integers(accountImportDefaults, "groupIds", "operations.accountImportDefaults", 1, Number.MAX_SAFE_INTEGER),
        sourceProxyId: integerValue(accountImportDefaults, "sourceProxyId", "operations.accountImportDefaults", 3),
        perAccountProxy: booleanValue(accountImportDefaults, "perAccountProxy", "operations.accountImportDefaults"),
        planType: (() => {
          const value = stringValue(accountImportDefaults, "planType", "operations.accountImportDefaults");
          if (value !== "k12" && value !== "plus" && value !== "team" && value !== "free") {
            throw new Error("operations.accountImportDefaults.planType must be k12, plus, team, or free");
          }
          return value;
        })(),
        freeCostThresholdCny: numberValue(accountImportDefaults, "freeCostThresholdCny", "operations.accountImportDefaults", 0),
        plusCostThresholdCny: numberValue(accountImportDefaults, "plusCostThresholdCny", "operations.accountImportDefaults", 0),
      },
      upstreamManagement: {
        pageSize: integerValue(upstreamManagement, "pageSize", "operations.upstreamManagement", 1, 100),
        defaultTemplate: stringValue(upstreamManagement, "defaultTemplate", "operations.upstreamManagement"),
        primaryGroupId: upstreamPrimaryGroupId,
        groupIds: upstreamGroupIds,
        priority: integerValue(upstreamManagement, "priority", "operations.upstreamManagement", 1, 1000),
        capacity: integerValue(upstreamManagement, "capacity", "operations.upstreamManagement", 1, 100000),
        proxyId: integerValue(upstreamManagement, "proxyId", "operations.upstreamManagement", 1),
        createBootstrapRateCnyPerApiUsd: numberValue(
          upstreamManagement,
          "createBootstrapRateCnyPerApiUsd",
          "operations.upstreamManagement",
          0.000001,
          1000,
        ),
        unprobedFallbackRateCnyPerApiUsd: numberValue(
          upstreamManagement,
          "unprobedFallbackRateCnyPerApiUsd",
          "operations.upstreamManagement",
          0.000001,
          1000,
        ),
        mutationTimeoutMs: integerValue(upstreamManagement, "mutationTimeoutMs", "operations.upstreamManagement", 1000, 120000),
        usageConcurrency: integerValue(upstreamManagement, "usageConcurrency", "operations.upstreamManagement", 1, 100),
        usageTimeoutMs: integerValue(upstreamManagement, "usageTimeoutMs", "operations.upstreamManagement", 1000, 120000),
        usageDays: integerValue(upstreamManagement, "usageDays", "operations.upstreamManagement", 1, 90),
        quotaSampleIntervalSeconds,
        quotaSampleTimeoutSeconds,
        rechargeCandidates: (() => {
          const value = object(upstreamManagement.rechargeCandidates, "operations.upstreamManagement.rechargeCandidates");
          return {
            lowBalanceCny: numberValue(value, "lowBalanceCny", "operations.upstreamManagement.rechargeCandidates", 0, 1000000),
            lookbackHours: integerValue(value, "lookbackHours", "operations.upstreamManagement.rechargeCandidates", 1, 168),
            recommendationLimit: integerValue(value, "recommendationLimit", "operations.upstreamManagement.rechargeCandidates", 1, 100),
            retiredSuppliers: strings(value, "retiredSuppliers", "operations.upstreamManagement.rechargeCandidates"),
          };
        })(),
        failoverRules: upstreamFailoverRules,
      },
      upstreamBenchmark: {
        enabled: booleanValue(upstreamBenchmark, "enabled", "operations.upstreamBenchmark"),
        provider: stringValue(upstreamBenchmark, "provider", "operations.upstreamBenchmark"),
        benchmarkVersion: stringValue(upstreamBenchmark, "benchmarkVersion", "operations.upstreamBenchmark"),
        model: stringValue(upstreamBenchmark, "model", "operations.upstreamBenchmark"),
        requestTimeoutMs: integerValue(upstreamBenchmark, "requestTimeoutMs", "operations.upstreamBenchmark", 1000, 300000),
      },
      oauthEconomics: {
        excludedAccountIds: integers(oauthEconomics, "excludedAccountIds", "operations.oauthEconomics", 1, Number.MAX_SAFE_INTEGER),
        idealApiUsdPerAccount: {
          free: numberValue(idealApiUsdPerAccount, "free", "operations.oauthEconomics.idealApiUsdPerAccount", 0.000001),
          k12: numberValue(idealApiUsdPerAccount, "k12", "operations.oauthEconomics.idealApiUsdPerAccount", 0.000001),
          plus: numberValue(idealApiUsdPerAccount, "plus", "operations.oauthEconomics.idealApiUsdPerAccount", 0.000001),
          team: numberValue(idealApiUsdPerAccount, "team", "operations.oauthEconomics.idealApiUsdPerAccount", 0.000001),
        },
      },
      rechargeDenominationsCny: integers(operations, "rechargeDenominationsCny", "operations", 1, 100000),
      planTtlMinutes: integerValue(operations, "planTtlMinutes", "operations", 1, 1440),
      auditLimit: integerValue(operations, "auditLimit", "operations", 1, 1000),
      priorityVerificationTimeoutMs: integerValue(operations, "priorityVerificationTimeoutMs", "operations", 1000, 120000),
      priorityVerificationPollMs: integerValue(operations, "priorityVerificationPollMs", "operations", 100, 10000),
      automationPollMs: integerValue(operations, "automationPollMs", "operations", 100, 60000),
      automationRunTimeoutMs: integerValue(operations, "automationRunTimeoutMs", "operations", 60000, 3600000),
      automationFailureBackoffMaxMs: integerValue(
        operations,
        "automationFailureBackoffMaxMs",
        "operations",
        1000,
        300000,
      ),
      automationFailureRetryLimit: integerValue(operations, "automationFailureRetryLimit", "operations", 0, 10),
      automationFailureCooldownMs: integerValue(
        operations,
        "automationFailureCooldownMs",
        "operations",
        60000,
        86400000,
      ),
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
        requestTimeoutMs: integerValue(
          priorityWrite,
          "requestTimeoutMs",
          "operations.priorityWrite",
          1000,
          120000,
        ),
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
      submissionTimeoutMs: integerValue(temporal, "submissionTimeoutMs", "temporal", 1000, 60000),
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
        mode: nativeMode,
        composeFile: stringValue(native, "composeFile", "runtime.native"),
        composeProject: stringValue(native, "composeProject", "runtime.native"),
        composeEnvFile: stringValue(native, "composeEnvFile", "runtime.native"),
        stateDir: stringValue(native, "stateDir", "runtime.native"),
        env: Object.fromEntries(Object.entries(nativeEnvRaw).map(([targetKey, value]) => [targetKey, secretRef(value, `runtime.native.env.${targetKey}`)])),
        temporalServiceRef: {
          executionPlane: nativeTemporalExecutionPlane,
          route: stringValue(nativeTemporalServiceRef, "route", "runtime.native.temporalServiceRef"),
          kubeconfig: stringValue(nativeTemporalServiceRef, "kubeconfig", "runtime.native.temporalServiceRef"),
          namespace: stringValue(nativeTemporalServiceRef, "namespace", "runtime.native.temporalServiceRef"),
          service: stringValue(nativeTemporalServiceRef, "service", "runtime.native.temporalServiceRef"),
          portName: stringValue(nativeTemporalServiceRef, "portName", "runtime.native.temporalServiceRef"),
          resolutionTimeoutMs: integerValue(nativeTemporalServiceRef, "resolutionTimeoutMs", "runtime.native.temporalServiceRef", 1000, 120000),
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
