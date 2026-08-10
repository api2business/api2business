import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { loadConfig } from "./config";
import { AdminHttpClient } from "./admin-http-client";
import { automationPollDelayMs } from "./automation-poll-backoff";
import { automationDispatchDelayMs } from "./priority-automation-dispatch";
import type { OperationRequest } from "./contracts";
import { requiredOption } from "./runtime-args";
import { temporalAddress, TemporalGateway } from "./temporal-client";
import { RemoteSub2ApiReadClient } from "./remote-sub2api-read-client";
import { UpstreamManagementService, type UpstreamWorkerOperation } from "./upstream-management";
import type { UpstreamUsageResult } from "./upstream-usage";
import { OperationsStore } from "./operations-store";
import { OperationsService } from "./operations-service";
import { AccountScoreService } from "./account-score-service";
import { Sub2ApiClient } from "./sub2api-client";
import { resolveDataPath } from "./config";
import { AccountImportService, type ImportJob } from "./account-import-service";
import { AccountLifecycleService, type LifecycleJob } from "./account-lifecycle-service";
import { Sub2ApiRuntimeService } from "./sub2api-runtime-service";
import { ProbeIsolationService } from "./probe-isolation";
import { idleProbeScheduleFreshness } from "./idle-probe-schedule-watchdog";
import { scoreScheduleFreshness } from "./score-schedule-watchdog";

const config = loadConfig(requiredOption("--config"));
const runtimeId = requiredOption("--runtime");
const target = config.runtime.serverTargets[runtimeId];
if (!target) throw new Error(`runtime.serverTargets.${runtimeId} does not exist`);

const internalTarget = config.runtime.cliTargets[config.runtime.overApiTarget];
if (!internalTarget || internalTarget.mode !== "http") {
  throw new Error("worker requires runtime.overApiTarget to reference the Native API");
}
const internal = new AdminHttpClient(config, runtimeId === "compose"
  ? { ...internalTarget, baseUrl: "http://127.0.0.1:8080", adminToken: { envKey: target.adminTokenEnv } }
  : internalTarget);
const temporalAddressValue = process.env[config.temporal.addressEnv];
const workflowEnabled = Boolean(temporalAddressValue);
const connection = workflowEnabled
  ? await NativeConnection.connect({ address: temporalAddress(config) })
  : null;
let temporalGateway: TemporalGateway | null = null;
const remoteReads = new RemoteSub2ApiReadClient(internal);
const email = process.env[target.sub2apiAdminEmailEnv];
const password = process.env[target.sub2apiAdminPasswordEnv];
if (!email || !password) throw new Error("worker requires Sub2API admin credentials");
const sub2apiClient = new Sub2ApiClient(config, { email, password });
const runtime = new Sub2ApiRuntimeService(sub2apiClient, config.operations.upstreamManagement.failoverRules);
const probeIsolation = new ProbeIsolationService(config, sub2apiClient, runtime);
const accountImports = new AccountImportService(config, remoteReads, null, {
  get: async (id): Promise<ImportJob | null> => {
    const response = await internal.accountImportWorkerJob(id);
    return response.job && typeof response.job === "object" ? response.job as ImportJob : null;
  },
  patch: async (id, patch): Promise<void> => {
    await internal.updateAccountImportWorkerJob(id, patch as Record<string, unknown>);
  },
}, runtime);
const accountLifecycle = new AccountLifecycleService(config, remoteReads, null, {
  get: async (id): Promise<LifecycleJob | null> => {
    const response = await internal.accountLifecycleWorkerJob(id);
    return response.job && typeof response.job === "object" ? response.job as LifecycleJob : null;
  },
  patch: async (id, patch): Promise<void> => {
    await internal.updateAccountLifecycleWorkerJob(id, patch as Record<string, unknown>);
  },
}, runtime);
const operationsDatabaseUrl = process.env[config.operations.databaseUrlEnv];
if (!operationsDatabaseUrl) throw new Error(`worker requires env ${config.operations.databaseUrlEnv}`);
const operationsStore = new OperationsStore(operationsDatabaseUrl);
const operations = new OperationsService(config, operationsStore, remoteReads, runtime, probeIsolation);
await operations.initialize();
const upstreams = new UpstreamManagementService(config, remoteReads, null, runtime, probeIsolation);
const scores = new AccountScoreService(
  config,
  resolveDataPath(config, target.scoreCachePath),
  sub2apiClient,
  remoteReads,
  operationsStore,
);

async function executeWorkerOperation(operation: OperationRequest): Promise<unknown> {
  const command = operation.command;
  if (command.kind === "scores.refresh") return await scores.refresh();
  const sampleUpstreamUsage = async () => {
    const result = await upstreams.usage([]);
    if (Array.isArray(result.results)) await internal.upstreamUsageCache(
      result.results as Array<Record<string, unknown>>, Number(result.apiAmountUsdTotal),
      true,
    );
    return { ok: true, sampled: result.targetCount, succeeded: result.succeeded, failed: result.failed };
  };
  if (command.kind === "upstream.usage.sample") return await sampleUpstreamUsage();
  if (command.kind === "pool.quality.sample") return await operations.samplePoolQuality();
  if (command.kind === "upstream.quota.sample") {
    const [oauth, usage, quality] = await Promise.allSettled([
      operations.sampleOAuthRuntime(),
      sampleUpstreamUsage(),
      operations.samplePoolQuality(),
    ]);
    const stages = { oauth, usage, quality };
    return {
      ok: Object.values(stages).every((stage) => stage.status === "fulfilled"),
      stages: Object.fromEntries(Object.entries(stages).map(([name, stage]) => [
        name,
        stage.status === "fulfilled"
          ? { ok: true, result: stage.value }
          : { ok: false, error: stage.reason instanceof Error ? stage.reason.message : String(stage.reason) },
      ])),
    };
  }
  if (command.kind === "oauth.runtime.sample") {
    return await operations.sampleOAuthRuntime();
  }
  if (command.kind === "upstream.benchmark") {
    return await operations.runUpstreamBenchmark(command.benchmarkRunId, command.accountId, command.model);
  }
  if (command.kind === "account.idle-probe.run") {
    return await operations.runIdleProbe(command.accountIds, command.rounds, {
      operationId: operation.operationId,
      triggerType: operation.operationId.includes(":idle-probe:") ? "automatic" : "manual",
    });
  }
  if (command.kind === "account.idle-probe.reconcile") {
    return await operations.reconcileIdleProbe(command.accountIds);
  }
  if (command.kind === "priority.plan.create") {
    return await operations.generatePriorityPlan(command.recentCallLimit, command.operator);
  }
  if (command.kind === "priority.plan.manual-create") {
    return await operations.createManualPriorityPlan(command.priorities, command.operator);
  }
  if (command.kind === "priority.plan.confirm") {
    return await operations.confirmPriorityPlan(command.planId, command.operator);
  }
  if (command.kind === "priority.automation.run") return await operations.runDueAutomation();
  if (command.kind === "account.import") {
    const job = await accountImports.runWorker(command.jobId);
    let postImportOAuthSample: Record<string, unknown> | null = null;
    if (job.state === "succeeded" && temporalGateway) {
      try {
        postImportOAuthSample = await temporalGateway.submit({ kind: "oauth.runtime.sample" });
      } catch (error) {
        postImportOAuthSample = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { ok: true, jobId: job.id, state: job.state, postImportOAuthSample, valuesPrinted: false };
  }
  if (command.kind === "account.lifecycle.detect") {
    const job = await accountLifecycle.runDetectWorker(command.jobId);
    return { ok: true, jobId: job.id, state: job.state, valuesPrinted: false };
  }
  if (command.kind === "account.lifecycle.settle") {
    const job = await accountLifecycle.runSettlementWorker(command.jobId, command.candidateIds);
    return { ok: true, jobId: job.id, state: job.state, valuesPrinted: false };
  }
  if (command.kind === "upstream.operation") {
    const response = await internal.upstreamOperation(command.operationId);
    const pending = response.operation as UpstreamWorkerOperation | undefined;
    if (!pending) throw new Error("上游 Temporal 作业缺少有效操作内容");
    let result: Record<string, unknown>;
    if (pending.action === "create") {
      result = await upstreams.create(pending.input);
      const createdAccount = result.account as { id?: unknown } | undefined;
      const accountId = Number(createdAccount?.id);
      if (result.skipDetection !== true && Number.isSafeInteger(accountId) && accountId > 0) {
        try {
          const detected = await upstreams.usage([accountId]);
          if (Array.isArray(detected.results)) {
            detected.rateSynchronization = await upstreams.synchronizeDetectedRates(
              detected.results as UpstreamUsageResult[],
              pending.input.rateWasSpecified
                ? {}
                : { fallbackRateCnyPerApiUsd: config.operations.upstreamManagement.unprobedFallbackRateCnyPerApiUsd },
            );
            await internal.upstreamUsageCache(
              detected.results as Array<Record<string, unknown>>,
              Number.isFinite(Number(detected.apiAmountUsdTotal)) ? Number(detected.apiAmountUsdTotal) : null,
              false,
            );
          }
          result.detection = detected;
        } catch (error) {
          result.detection = {
            ok: false,
            accountId,
            error: error instanceof Error ? error.message : String(error),
          };
          let fallbackApplied = false;
          if (pending.input.rateWasSpecified === false) {
            try {
              await upstreams.update(accountId, {
                rateCnyPerApiUsd: config.operations.upstreamManagement.unprobedFallbackRateCnyPerApiUsd,
              });
              fallbackApplied = true;
            } catch (fallbackError) {
              result.warnings = [
                ...(Array.isArray(result.warnings) ? result.warnings : []),
                `探测失败后的回退费率写入失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
              ];
            }
          }
          result.warnings = [
            ...(Array.isArray(result.warnings) ? result.warnings : []),
            fallbackApplied
              ? `账号已创建，探测失败，已回退费率 ${config.operations.upstreamManagement.unprobedFallbackRateCnyPerApiUsd} 元/刀；下一轮采样将重试探测`
              : "账号已创建，但额度或倍率探测失败；下一轮采样将重试探测",
          ];
        }
      }
    } else if (pending.action === "update") result = await upstreams.update(pending.input.id, pending.input);
    else if (pending.action === "recharge") result = await upstreams.recharge(pending.input.id, pending.input);
    else if (pending.action === "isolation") result = await upstreams.ensureProbeIsolation(pending.input.accountIds);
    else if (pending.action === "template") result = await upstreams.applyTemplate(pending.input.accountIds);
    else {
      result = await upstreams.usage(pending.input.accountIds);
      if (Array.isArray(result.results)) {
        result.rateSynchronization = await upstreams.synchronizeDetectedRates(result.results as UpstreamUsageResult[]);
        await internal.upstreamUsageCache(
        result.results as Array<Record<string, unknown>>,
        Number.isFinite(Number(result.apiAmountUsdTotal)) ? Number(result.apiAmountUsdTotal) : null,
        pending.input.accountIds.length === 0,
        );
        if (pending.input.accountIds.length === 0) {
          result.oauth = await operations.sampleOAuthRuntime();
          result.quality = await operations.samplePoolQuality();
        }
      }
    }
    await internal.completeUpstreamOperation(command.operationId);
    return result;
  }
  return await internal.executeOperation(operation);
}
const worker = connection
  ? await Worker.create({
    connection,
    namespace: config.temporal.namespace,
    taskQueue: target.temporalTaskQueue,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities: {
      executeOperation: executeWorkerOperation,
    },
  })
  : null;
temporalGateway = workflowEnabled
  ? await TemporalGateway.connect(config, {
    taskQueue: target.temporalTaskQueue,
    scoreScheduleWorkflowId: target.scoreScheduleWorkflowId,
  })
  : null;
const schedule = temporalGateway
  && config.monitor.automaticRefresh.enabled
  ? await temporalGateway.ensureScoreSchedule()
  : {
    enabled: config.monitor.automaticRefresh.enabled,
    started: false,
    workflowId: target.scoreScheduleWorkflowId,
  };
const quotaSchedule = temporalGateway ? await temporalGateway.ensureUpstreamQuotaSchedule() : { started: false, workflowId: null };
const idleProbeSchedule = temporalGateway
  ? await temporalGateway.ensureIdleProbeSchedule()
  : { started: false, workflowId: null };
let state: "ready" | "stopping" = "ready";
const health = Bun.serve({
  hostname: target.workerHealthHost,
  port: target.workerHealthPort,
  fetch: async () => {
    let databaseReady = false;
    if (state === "ready") {
      databaseReady = await operationsStore.health().then(() => true).catch(() => false);
    }
    const ok = state === "ready" && databaseReady;
    return Response.json({
      ok,
      component: "api2business-worker",
      state,
      databaseReady,
      workflowMode: workflowEnabled ? "temporal" : "disabled",
      namespace: workflowEnabled ? config.temporal.namespace : null,
      taskQueue: workflowEnabled ? target.temporalTaskQueue : null,
      schedule,
      quotaSchedule,
      idleProbeSchedule,
    }, { status: ok ? 200 : 503 });
  },
});

console.log(JSON.stringify({
  ok: true,
  component: "api2business-worker",
  runtime: runtimeId,
  health: health.url.toString(),
  workflowMode: workflowEnabled ? "temporal" : "disabled",
  temporalNamespace: workflowEnabled ? config.temporal.namespace : null,
  temporalTaskQueue: workflowEnabled ? target.temporalTaskQueue : null,
  schedule,
  quotaSchedule,
  idleProbeSchedule,
  valuesPrinted: false,
}));

let stopping = false;
let wakeIdleProbeWatchdog = () => {};
let wakeScoreWatchdog = () => {};
async function waitForIdleProbeWatchdog(delayMs: number): Promise<void> {
  if (stopping) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      wakeIdleProbeWatchdog = () => {};
      resolve();
    }, delayMs);
    wakeIdleProbeWatchdog = () => {
      clearTimeout(timer);
      wakeIdleProbeWatchdog = () => {};
      resolve();
    };
  });
}
const idleProbeWatchdogStartedAtMs = Date.now();
const idleProbeWatchdog = (async () => {
  if (!temporalGateway || !config.sub2api.idleProbe.enabled) return;
  while (!stopping) {
    try {
      const latest = await operationsStore.latestAutomaticIdleProbeRound();
      const freshness = idleProbeScheduleFreshness({
        nowMs: Date.now(),
        workerStartedAtMs: idleProbeWatchdogStartedAtMs,
        lastAutomaticCompletedAt: latest?.completed_at ?? null,
        intervalSeconds: config.sub2api.idleProbe.intervalSeconds,
        roundTimeoutSeconds: config.sub2api.idleProbe.roundTimeoutSeconds,
      });
      if (freshness.stale) {
        const recovered = await temporalGateway.replaceIdleProbeSchedule(
          `automatic idle probe stale for ${freshness.ageMs}ms (${freshness.reference})`,
        );
        console.log(JSON.stringify({
          ok: true,
          component: "idle-probe-schedule-watchdog",
          action: "replaced",
          ...freshness,
          ...recovered,
          valuesPrinted: false,
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        ok: false,
        component: "idle-probe-schedule-watchdog",
        action: "deferred-to-next-cycle",
        error: error instanceof Error ? error.message : String(error),
        valuesPrinted: false,
      }));
    }
    await waitForIdleProbeWatchdog(config.sub2api.idleProbe.intervalSeconds * 1000);
  }
})();
const scoreWatchdogStartedAtMs = Date.now();
const scoreWatchdog = (async () => {
  if (!temporalGateway || !config.monitor.automaticRefresh.enabled) return;
  let startupGrace = Boolean(schedule.started);
  while (!stopping) {
    try {
      const snapshot = await operationsStore.getSnapshot("account-scores");
      const freshness = scoreScheduleFreshness({
        nowMs: Date.now(),
        workerStartedAtMs: scoreWatchdogStartedAtMs,
        capturedAt: startupGrace ? null : snapshot?.captured_at ? String(snapshot.captured_at) : null,
        intervalMinutes: config.monitor.refreshIntervalMinutes,
      });
      startupGrace = false;
      if (freshness.stale) {
        const recovered = await temporalGateway.replaceScoreSchedule(
          `automatic score snapshot stale for ${freshness.ageMs}ms (${freshness.reference})`,
        );
        console.log(JSON.stringify({
          ok: true,
          component: "score-schedule-watchdog",
          action: "replaced",
          ...freshness,
          ...recovered,
          valuesPrinted: false,
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        ok: false,
        component: "score-schedule-watchdog",
        action: "deferred-to-next-cycle",
        error: error instanceof Error ? error.message : String(error),
        valuesPrinted: false,
      }));
    }
    if (!stopping) await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeScoreWatchdog = () => {};
        resolve();
      }, Math.max(30_000, config.monitor.refreshIntervalMinutes * 60_000));
      wakeScoreWatchdog = () => {
        clearTimeout(timer);
        wakeScoreWatchdog = () => {};
        resolve();
      };
    });
  }
})();
let consecutiveAutomationFailures = 0;
const automationLoop = (async () => {
  while (!stopping) {
    let nextDelayMs = config.operations.automationPollMs;
    try {
      const dispatch = automationDispatchDelayMs(
        await operations.priorityAutomationDispatchState(),
        Date.now(),
        config.operations.automationRunTimeoutMs,
        config.operations.automationFailureBackoffMaxMs,
      );
      if (!dispatch.due) {
        consecutiveAutomationFailures = 0;
        nextDelayMs = dispatch.delayMs;
        if (!stopping) await Bun.sleep(nextDelayMs);
        continue;
      }
      const result = temporalGateway
        ? await temporalGateway.execute({ kind: "priority.automation.run" }) as Awaited<ReturnType<OperationsService["runDueAutomation"]>>
        : await operations.runDueAutomation();
      consecutiveAutomationFailures = 0;
      nextDelayMs = config.operations.automationPollMs;
      if (result.due || (result as Record<string, unknown>).recovered === true) {
        console.log(JSON.stringify({ component: "priority-automation", ...result, valuesPrinted: false }));
      }
    } catch (error) {
      consecutiveAutomationFailures += 1;
      const deferred = await operations.deferPriorityAutomationAfterDispatchFailure(error).catch(() => null);
      nextDelayMs = deferred
        ? config.operations.automationPollMs
        : automationPollDelayMs(
          config.operations.automationPollMs,
          config.operations.automationFailureBackoffMaxMs,
          consecutiveAutomationFailures,
          config.operations.automationFailureRetryLimit,
          config.operations.automationFailureCooldownMs,
        );
      console.error(JSON.stringify({
        ok: false, component: "priority-automation",
        error: error instanceof Error ? error.message : String(error), valuesPrinted: false,
        consecutiveFailures: consecutiveAutomationFailures,
        deferredToNextCycle: deferred !== null,
        nextRunAt: deferred?.next_run_at ?? null,
        nextPollDelayMs: nextDelayMs,
      }));
    }
    if (!stopping) {
      await Bun.sleep(nextDelayMs);
    }
  }
})();
let resolveStandaloneStop = () => {};
const standaloneStop = new Promise<void>((resolve) => {
  resolveStandaloneStop = resolve;
});
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  wakeIdleProbeWatchdog();
  wakeScoreWatchdog();
  state = "stopping";
  health.stop(true);
  if (worker) worker.shutdown();
  else resolveStandaloneStop();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop());

try {
  if (worker) await worker.run();
  else await standaloneStop;
} finally {
  stopping = true;
  wakeIdleProbeWatchdog();
  wakeScoreWatchdog();
  state = "stopping";
  health.stop(true);
  await idleProbeWatchdog;
  await scoreWatchdog;
  await automationLoop;
  scores.close();
  await operations.close();
  if (temporalGateway) await temporalGateway.close();
  if (connection) await connection.close();
  console.log(JSON.stringify({ ok: true, component: "api2business-worker", state: "stopped", valuesPrinted: false }));
}
