import { createServerContext } from "./bootstrap";
import { loadConfig } from "./config";
import { ApplicationDispatcher } from "./dispatcher";
import { createHandler } from "./http";
import { requiredOption } from "./runtime-args";
import { TemporalGateway } from "./temporal-client";
import { OperationsStore } from "./operations-store";
import { OperationsService } from "./operations-service";

const config = loadConfig(requiredOption("--config"));
const runtimeId = requiredOption("--runtime");
const target = config.runtime.serverTargets[runtimeId];
if (!target) throw new Error(`runtime.serverTargets.${runtimeId} does not exist`);
const adminToken = process.env[target.adminTokenEnv];
if (!adminToken) throw new Error(`server target requires env ${target.adminTokenEnv}`);

const context = createServerContext(config, target);
const temporal = await TemporalGateway.connect(config, { taskQueue: target.temporalTaskQueue, scoreScheduleWorkflowId: target.scoreScheduleWorkflowId });
const dispatcher = new ApplicationDispatcher({ lottery: context.service, scores: context.monitor }, temporal);
const operationsDatabaseUrl = process.env[config.operations.databaseUrlEnv];
if (!operationsDatabaseUrl) throw new Error(`server target requires env ${config.operations.databaseUrlEnv}`);
const operations = new OperationsService(config, new OperationsStore(operationsDatabaseUrl), process.env[target.scoreDatabaseUrlEnv]!);
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
  temporalNamespace: config.temporal.namespace,
  temporalTaskQueue: target.temporalTaskQueue,
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
  await temporal.close();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop());
