import { createServerContext } from "./bootstrap";
import { loadConfig } from "./config";
import { ApplicationDispatcher } from "./dispatcher";
import { createHandler } from "./http";
import { requiredOption } from "./runtime-args";
import { TemporalGateway } from "./temporal-client";
import { OperationsStore } from "./operations-store";
import { OperationsService } from "./operations-service";
import { AccountImportService } from "./account-import-service";
import { AccountLifecycleService } from "./account-lifecycle-service";
import { SingleConnectionSub2ApiReadExecutor } from "./sub2api-read-executor";
import { UpstreamManagementService } from "./upstream-management";
import { createWorkerOperationExecutor } from "./worker-operation";
import { ProbeIsolationService } from "./probe-isolation";
import { BugTeamClient } from "./bugteam-client";
import { BugTeamPurchaseImportService } from "./bugteam-purchase-import-service";

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
const operationsDatabaseUrl = process.env[config.operations.databaseUrlEnv];
if (!operationsDatabaseUrl) throw new Error(`server target requires env ${config.operations.databaseUrlEnv}`);
const operationsStore = new OperationsStore(operationsDatabaseUrl);
await operationsStore.migrate();
const context = createServerContext(config, target, reads, operationsStore);
const probeIsolation = new ProbeIsolationService(config, context.admin, context.runtime);
const temporalAddress = process.env[config.temporal.addressEnv];
const temporal = temporalAddress
  ? await TemporalGateway.connect(config, { taskQueue: target.temporalTaskQueue, scoreScheduleWorkflowId: target.scoreScheduleWorkflowId })
  : null;
const dispatcher = new ApplicationDispatcher({ lottery: context.service, scores: context.monitor }, temporal);
const operations = new OperationsService(
  config,
  operationsStore,
  reads,
  context.runtime,
  probeIsolation,
);
const imports = new AccountImportService(config, reads, temporal, null, context.runtime);
const purchases = new BugTeamPurchaseImportService(config, temporal);
const lifecycle = new AccountLifecycleService(config, reads, temporal, null, context.runtime);
const upstreams = new UpstreamManagementService(config, reads, temporal, context.runtime, probeIsolation);
const workerImports = new AccountImportService(config, reads, null, {
  get: async (id) => imports.workerGet(id),
  patch: async (id, patch) => { imports.applyWorkerPatch(id, patch); },
}, context.runtime);
const workerPurchases = new BugTeamPurchaseImportService(config, null, {
  get: async (id) => purchases.workerGet(id),
  patch: async (id, patch) => { purchases.applyWorkerPatch(id, patch); },
}, new BugTeamClient(config), {
  submit: async (input) => await imports.submit(input as never),
  get: async (id) => imports.get(id),
});
const workerLifecycle = new AccountLifecycleService(config, reads, null, {
  get: async (id) => lifecycle.workerGet(id),
  patch: async (id, patch) => { lifecycle.applyWorkerPatch(id, patch); },
}, context.runtime);
const executeWorkerOperation = createWorkerOperationExecutor({
  dispatcher, scores: context.monitor, operations, imports: workerImports,
  lifecycle: workerLifecycle, upstreams, temporal, purchases: workerPurchases,
});
const server = Bun.serve({
  hostname: target.listenHost,
  port: target.listenPort,
  fetch: createHandler(dispatcher, config, context.auth, adminToken, target.secureCookies, operations, imports, purchases, lifecycle, upstreams, reads, context.runtime, executeWorkerOperation),
});

console.log(JSON.stringify({
  ok: true,
  component: "api2business-api",
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
