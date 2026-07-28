import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { loadConfig } from "./config";
import { AdminHttpClient } from "./admin-http-client";
import type { OperationRequest } from "./contracts";
import { requiredOption } from "./runtime-args";
import { temporalAddress, TemporalGateway } from "./temporal-client";

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
const workflowEnabled = config.monitor.automaticRefresh.enabled;
const connection = workflowEnabled
  ? await NativeConnection.connect({ address: temporalAddress(config) })
  : null;
const worker = connection
  ? await Worker.create({
    connection,
    namespace: config.temporal.namespace,
    taskQueue: target.temporalTaskQueue,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities: {
      executeOperation: async (operation: OperationRequest) =>
        await internal.executeOperation(operation),
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
  ? await temporal.ensureScoreSchedule()
  : {
    enabled: false,
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
const automationLoop = (async () => {
  while (!stopping) {
    try {
      const result = await internal.runDueAutomation();
      if (result.due) console.log(JSON.stringify({ component: "priority-automation", ...result, valuesPrinted: false }));
    } catch (error) {
      console.error(JSON.stringify({
        ok: false, component: "priority-automation",
        error: error instanceof Error ? error.message : String(error), valuesPrinted: false,
      }));
    }
    if (!stopping) await Bun.sleep(config.operations.automationPollMs);
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
  if (temporal) await temporal.close();
  if (connection) await connection.close();
  console.log(JSON.stringify({ ok: true, component: "apistate-worker", state: "stopped", valuesPrinted: false }));
}
