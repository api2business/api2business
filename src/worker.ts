import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createServerContext } from "./bootstrap";
import { loadConfig } from "./config";
import { createActivities } from "./dispatcher";
import { requiredOption } from "./runtime-args";
import { temporalAddress, TemporalGateway } from "./temporal-client";
import { OperationsService } from "./operations-service";
import { OperationsStore } from "./operations-store";

const config = loadConfig(requiredOption("--config"));
const runtimeId = requiredOption("--runtime");
const target = config.runtime.serverTargets[runtimeId];
if (!target) throw new Error(`runtime.serverTargets.${runtimeId} does not exist`);

const context = createServerContext(config, target);
const operationsDatabaseUrl = process.env[config.operations.databaseUrlEnv];
const scoreDatabaseUrl = process.env[target.scoreDatabaseUrlEnv];
if (!operationsDatabaseUrl || !scoreDatabaseUrl) throw new Error("worker is missing declared operations or score database URL");
const operations = new OperationsService(config, new OperationsStore(operationsDatabaseUrl), scoreDatabaseUrl);
await operations.initialize();
const connection = await NativeConnection.connect({ address: temporalAddress(config) });
const worker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue: target.temporalTaskQueue,
  workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
  activities: createActivities({ lottery: context.service, scores: context.monitor }),
});
const temporal = await TemporalGateway.connect(config, { taskQueue: target.temporalTaskQueue, scoreScheduleWorkflowId: target.scoreScheduleWorkflowId });
const schedule = await temporal.ensureScoreSchedule();
let state: "ready" | "stopping" = "ready";
const health = Bun.serve({
  hostname: target.workerHealthHost,
  port: target.workerHealthPort,
  fetch: () => Response.json({
    ok: state === "ready",
    component: "apistate-worker",
    state,
    namespace: config.temporal.namespace,
    taskQueue: target.temporalTaskQueue,
    schedule,
  }, { status: state === "ready" ? 200 : 503 }),
});

console.log(JSON.stringify({
  ok: true,
  component: "apistate-worker",
  runtime: runtimeId,
  health: health.url.toString(),
  temporalNamespace: config.temporal.namespace,
  temporalTaskQueue: target.temporalTaskQueue,
  schedule,
  valuesPrinted: false,
}));

let stopping = false;
const automationLoop = (async () => {
  while (!stopping) {
    try {
      const result = await operations.runDueAutomation();
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
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  state = "stopping";
  health.stop(true);
  worker.shutdown();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop());

try {
  await worker.run();
} finally {
  await automationLoop;
  await operations.close();
  await temporal.close();
  await connection.close();
  context.close();
  console.log(JSON.stringify({ ok: true, component: "apistate-worker", state: "stopped", valuesPrinted: false }));
}
