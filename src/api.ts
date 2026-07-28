import { createServerContext } from "./bootstrap";
import { loadConfig } from "./config";
import { ApplicationDispatcher } from "./dispatcher";
import { createHandler } from "./http";
import { requiredOption } from "./runtime-args";
import { TemporalGateway } from "./temporal-client";
import { OperationsStore } from "./operations-store";
import { OperationsService } from "./operations-service";
import { SingleConnectionSub2ApiReadExecutor } from "./sub2api-read-executor";

const config = loadConfig(requiredOption("--config"));
const runtimeId = requiredOption("--runtime");
const target = config.runtime.serverTargets[runtimeId];
if (!target) throw new Error(`runtime.serverTargets.${runtimeId} does not exist`);
const adminToken = process.env[target.adminTokenEnv];
if (!adminToken) throw new Error(`server target requires env ${target.adminTokenEnv}`);

const scoreDatabaseUrl = process.env[target.scoreDatabaseUrlEnv];
if (!scoreDatabaseUrl) throw new Error(`server target requires env ${target.scoreDatabaseUrlEnv}`);
const reads = new SingleConnectionSub2ApiReadExecutor(
  scoreDatabaseUrl,
  config.sub2api.scoreDatabase,
);
const context = createServerContext(config, target, reads);
const temporalAddress = process.env[config.temporal.addressEnv];
if (runtimeId !== "native" && !temporalAddress) throw new Error(`server target requires env ${config.temporal.addressEnv}`);
const temporal = temporalAddress
  ? await TemporalGateway.connect(config, { taskQueue: target.temporalTaskQueue, scoreScheduleWorkflowId: target.scoreScheduleWorkflowId })
  : null;
const dispatcher = new ApplicationDispatcher({ lottery: context.service, scores: context.monitor }, temporal);
const operationsDatabaseUrl = process.env[config.operations.databaseUrlEnv];
if (!operationsDatabaseUrl) throw new Error(`server target requires env ${config.operations.databaseUrlEnv}`);
const operations = new OperationsService(
  config,
  new OperationsStore(operationsDatabaseUrl),
  reads,
);
await operations.initialize();
const server = Bun.serve({
  hostname: target.listenHost,
  port: target.listenPort,
  fetch: createHandler(dispatcher, config, context.auth, adminToken, target.secureCookies, operations),
});

console.log(JSON.stringify({
  ok: true,
  component: "apistate-api",
  runtime: runtimeId,
  listen: server.url.toString(),
  temporalNamespace: temporal ? config.temporal.namespace : null,
  temporalTaskQueue: temporal ? target.temporalTaskQueue : null,
  workflowMode: temporal ? "temporal" : "disabled",
  automaticCreditEnabled: config.lottery.automaticCredit.enabled,
  valuesPrinted: false,
}));

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  context.close();
  await operations.close();
  await reads.close();
  if (temporal) await temporal.close();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop());
