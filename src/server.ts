import { loadConfig } from "./config";
import { createServerContext } from "./bootstrap";
import { createHandler } from "./http";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const config = loadConfig(option("--config"));
const runtimeId = option("--runtime");
const target = config.runtime.serverTargets[runtimeId];
if (!target) throw new Error(`runtime.serverTargets.${runtimeId} does not exist`);
const adminToken = process.env[target.adminTokenEnv];
if (!adminToken) throw new Error(`server target requires env ${target.adminTokenEnv}`);
const context = createServerContext(config, target);
const server = Bun.serve({
  hostname: target.listenHost,
  port: target.listenPort,
  fetch: createHandler(context.service, context.monitor, config, context.auth, adminToken),
});

context.monitor.start();

console.log(JSON.stringify({ ok: true, service: config.metadata.name, runtime: runtimeId, listen: server.url.toString(), automaticCreditEnabled: config.lottery.automaticCredit.enabled }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    context.close();
    server.stop(true);
    process.exit(0);
  });
}
