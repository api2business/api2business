import { createServerContext } from "./bootstrap";
import { loadConfig } from "./config";
import { ApplicationDispatcher } from "./dispatcher";
import { createHandler } from "./http";
import { requiredOption } from "./runtime-args";
import { TemporalGateway } from "./temporal-client";

const config = loadConfig(requiredOption("--config"));
const runtimeId = requiredOption("--runtime");
const target = config.runtime.serverTargets[runtimeId];
if (!target) throw new Error(`runtime.serverTargets.${runtimeId} does not exist`);
const adminToken = process.env[target.adminTokenEnv];
if (!adminToken) throw new Error(`server target requires env ${target.adminTokenEnv}`);

const context = createServerContext(config, target);
const temporal = await TemporalGateway.connect(config);
const dispatcher = new ApplicationDispatcher({ lottery: context.service, scores: context.monitor }, temporal);
const server = Bun.serve({
  hostname: target.listenHost,
  port: target.listenPort,
  fetch: createHandler(dispatcher, config, context.auth, adminToken),
});

console.log(JSON.stringify({
  ok: true,
  component: "apistate-api",
  runtime: runtimeId,
  listen: server.url.toString(),
  temporalNamespace: config.temporal.namespace,
  temporalTaskQueue: config.temporal.taskQueue,
  automaticCreditEnabled: config.lottery.automaticCredit.enabled,
  valuesPrinted: false,
}));

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  context.close();
  await temporal.close();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop());
