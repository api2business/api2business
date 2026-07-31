import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { loadConfig } from "./config";
import { AdminHttpClient } from "./admin-http-client";
import { automationPollDelayMs } from "./automation-poll-backoff";
import type { OperationRequest } from "./contracts";
import { requiredOption } from "./runtime-args";
import { temporalAddress, TemporalGateway } from "./temporal-client";
import { RemoteSub2ApiReadClient } from "./remote-sub2api-read-client";
import { UpstreamManagementService, type UpstreamWorkerOperation } from "./upstream-management";
import { OperationsStore } from "./operations-store";
import { OperationsService } from "./operations-service";
import { AccountScoreService } from "./account-score-service";
import { Sub2ApiClient } from "./sub2api-client";
import { UniDeskRuntimePolicyEventSource } from "./runtime-policy-events";
import { resolveDataPath } from "./config";

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
const remoteReads = new RemoteSub2ApiReadClient(internal);
const operationsDatabaseUrl = process.env[config.operations.databaseUrlEnv];
if (!operationsDatabaseUrl) throw new Error(`worker requires env ${config.operations.databaseUrlEnv}`);
const operations = new OperationsService(config, new OperationsStore(operationsDatabaseUrl), remoteReads);
await operations.initialize();
const upstreams = new UpstreamManagementService(config, remoteReads);
const email = process.env[target.sub2apiAdminEmailEnv];
const password = process.env[target.sub2apiAdminPasswordEnv];
if (!email || !password) throw new Error("worker requires Sub2API admin credentials");
const scores = new AccountScoreService(
  config,
  resolveDataPath(config, target.scoreCachePath),
  new Sub2ApiClient(config, { email, password }),
  new UniDeskRuntimePolicyEventSource(config, target.monitorWorkDir),
  remoteReads,
);

async function executeWorkerOperation(operation: OperationRequest): Promise<unknown> {
  const command = operation.command;
  if (command.kind === "scores.refresh") return await scores.refresh();
  if (command.kind === "priority.plan.create") {
    return await operations.generatePriorityPlan(command.recentCallLimit, command.operator);
  }
  if (command.kind === "priority.plan.confirm") {
    return await operations.confirmPriorityPlan(command.planId, command.operator);
  }
  if (command.kind === "priority.automation.run") return await operations.runDueAutomation();
  if (command.kind === "upstream.operation") {
    const response = await internal.upstreamOperation(command.operationId);
    const pending = response.operation as UpstreamWorkerOperation | undefined;
    if (!pending) throw new Error("上游 Temporal 作业缺少有效操作内容");
    let result: Record<string, unknown>;
    if (pending.action === "create") result = await upstreams.create(pending.input);
    else if (pending.action === "update") result = await upstreams.update(pending.input.id, pending.input);
    else result = await upstreams.recharge(pending.input.id, pending.input);
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
const temporal = workflowEnabled
  ? await TemporalGateway.connect(config, {
    taskQueue: target.temporalTaskQueue,
    scoreScheduleWorkflowId: target.scoreScheduleWorkflowId,
  })
  : null;
const schedule = temporal
  && config.monitor.automaticRefresh.enabled
  ? await temporal.ensureScoreSchedule()
  : {
    enabled: config.monitor.automaticRefresh.enabled,
    started: false,
    workflowId: target.scoreScheduleWorkflowId,
  };
let state: "ready" | "stopping" = "ready";
const health = Bun.serve({
  hostname: target.workerHealthHost,
  port: target.workerHealthPort,
  fetch: () => Response.json({
    ok: state === "ready",
    component: "apistate-worker",
    state,
    workflowMode: workflowEnabled ? "temporal" : "disabled",
    namespace: workflowEnabled ? config.temporal.namespace : null,
    taskQueue: workflowEnabled ? target.temporalTaskQueue : null,
    schedule,
  }, { status: state === "ready" ? 200 : 503 }),
});

console.log(JSON.stringify({
  ok: true,
  component: "apistate-worker",
  runtime: runtimeId,
  health: health.url.toString(),
  workflowMode: workflowEnabled ? "temporal" : "disabled",
  temporalNamespace: workflowEnabled ? config.temporal.namespace : null,
  temporalTaskQueue: workflowEnabled ? target.temporalTaskQueue : null,
  schedule,
  valuesPrinted: false,
}));

let stopping = false;
let consecutiveAutomationFailures = 0;
const automationLoop = (async () => {
  while (!stopping) {
    try {
      const result = temporal
        ? await temporal.execute({ kind: "priority.automation.run" }) as Awaited<ReturnType<OperationsService["runDueAutomation"]>>
        : await operations.runDueAutomation();
      consecutiveAutomationFailures = 0;
      if (result.due || (result as Record<string, unknown>).recovered === true) {
        console.log(JSON.stringify({ component: "priority-automation", ...result, valuesPrinted: false }));
      }
    } catch (error) {
      consecutiveAutomationFailures += 1;
      console.error(JSON.stringify({
        ok: false, component: "priority-automation",
        error: error instanceof Error ? error.message : String(error), valuesPrinted: false,
        consecutiveFailures: consecutiveAutomationFailures,
        nextPollDelayMs: automationPollDelayMs(
          config.operations.automationPollMs,
          config.operations.automationFailureBackoffMaxMs,
          consecutiveAutomationFailures,
          config.operations.automationFailureRetryLimit,
          config.operations.automationFailureCooldownMs,
        ),
      }));
    }
    if (!stopping) {
      await Bun.sleep(automationPollDelayMs(
        config.operations.automationPollMs,
        config.operations.automationFailureBackoffMaxMs,
        consecutiveAutomationFailures,
        config.operations.automationFailureRetryLimit,
        config.operations.automationFailureCooldownMs,
      ));
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
  state = "stopping";
  health.stop(true);
  await automationLoop;
  scores.close();
  await operations.close();
  if (temporal) await temporal.close();
  if (connection) await connection.close();
  console.log(JSON.stringify({ ok: true, component: "apistate-worker", state: "stopped", valuesPrinted: false }));
}
