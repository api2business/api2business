import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { AppConfig, NativeServiceId } from "./config";
import { readSecret } from "./secrets";

const nativeComponents: NativeServiceId[] = ["api", "worker", "web"];

function composeArgs(config: AppConfig, action: string, component?: NativeServiceId): string[] {
  const n = config.runtime.native;
  const args = ["compose", "--project-name", n.composeProject, "--file", resolve(config.rootDirectory, n.composeFile), "--env-file", resolve(config.rootDirectory, n.composeEnvFile), action];
  if (action === "up") args.push("--detach", "--build");
  if (component) args.push(component);
  return args;
}

function composeRun(config: AppConfig, action: string, component?: NativeServiceId, tail = 40): Record<string, unknown> {
  if (action === "up") {
    const ledgerDirectory = dirname(config.operations.accountImportLedgerPath);
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 });
    chmodSync(ledgerDirectory, 0o700);
    mkdirSync(config.operations.accountImportArchiveDirectory, { recursive: true, mode: 0o700 });
    chmodSync(config.operations.accountImportArchiveDirectory, 0o700);
    const envPath = resolve(config.rootDirectory, config.runtime.native.composeEnvFile);
    mkdirSync(resolve(envPath, ".."), { recursive: true, mode: 0o700 });
    const lines = Object.entries(config.runtime.native.env).map(([key, ref]) => `${key}=${readSecret(config, ref).replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n")}`);
    lines.push(`${config.temporal.addressEnv}=${resolveTemporalAddress(config)}`);
    writeFileSync(envPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(envPath, 0o600);
  }
  const args = composeArgs(config, action, component);
  if (action === "logs") args.push("--tail", String(tail));
  const result = spawnSync("docker", args, { cwd: config.rootDirectory, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `docker compose ${action} failed`).trim());
  if (action === "ps") return { ok: true, component: component ?? "all", action, output: result.stdout.trim(), mutation: false, valuesPrinted: false };
  return { ok: true, component: component ?? "all", action, output: result.stdout.trim(), mutation: action === "up" || action === "stop" || action === "down", valuesPrinted: false };
}

function resolveTemporalAddress(config: AppConfig): string {
  const ref = config.runtime.native.temporalServiceRef;
  const kubectlArgs = [
    "-n",
    ref.namespace,
    "get",
    "service",
    ref.service,
    "-o",
    `jsonpath={.spec.clusterIP}:{.spec.ports[?(@.name=="${ref.portName}")].port}`,
  ];
  const command = ref.executionPlane === "local-k3s" ? "kubectl" : "trans";
  const args = ref.executionPlane === "local-k3s"
    ? ["--kubeconfig", ref.kubeconfig, ...kubectlArgs]
    : [ref.route, "kubectl", ...kubectlArgs];
  const result = spawnSync(command, args, { encoding: "utf8", timeout: ref.resolutionTimeoutMs });
  const address = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f:.]+:[1-9][0-9]*$/iu.test(address)) {
    throw new Error(`native temporal service resolution failed for ${ref.namespace}/${ref.service}`);
  }
  return address;
}

function paths(config: AppConfig, component: NativeServiceId): { stateDir: string; pid: string; log: string } {
  const service = config.runtime.native.services[component];
  const stateDir = resolve(config.rootDirectory, config.runtime.native.stateDir);
  return { stateDir, pid: resolve(stateDir, service.pidFile), log: resolve(stateDir, service.logFile) };
}

function processId(path: string): number | null {
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function running(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function nativeComponentRequiresTemporalAddress(
  config: AppConfig,
  component: NativeServiceId,
): boolean {
  return config.runtime.native.services[component].envKeys.includes(config.temporal.addressEnv);
}

function nativeEnvironment(
  config: AppConfig,
  component: NativeServiceId,
): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const targetKey of Object.keys(config.runtime.native.env)) delete env[targetKey];
  delete env[config.temporal.addressEnv];
  const envKeys = new Set(config.runtime.native.services[component].envKeys);
  for (const targetKey of envKeys) {
    const ref = config.runtime.native.env[targetKey];
    if (ref) env[targetKey] = readSecret(config, ref);
  }
  if (nativeComponentRequiresTemporalAddress(config, component)) {
    env[config.temporal.addressEnv] = resolveTemporalAddress(config);
  }
  env.APISTATE_CONFIG_PATH = config.configPath;
  env.APISTATE_RUNTIME_ID = "native";
  return env;
}

export function nativeStatus(config: AppConfig, component: NativeServiceId): Record<string, unknown> {
  if (config.runtime.native.mode === "docker-compose") return composeRun(config, "ps", component);
  const target = paths(config, component);
  const pid = processId(target.pid);
  return {
    ok: true,
    component,
    state: running(pid) ? "running" : "stopped",
    pid: running(pid) ? pid : null,
    pidFile: target.pid,
    logFile: target.log,
    valuesPrinted: false,
  };
}

export function nativeStart(
  config: AppConfig,
  component: NativeServiceId,
  preparedEnvironment?: Record<string, string>,
): Record<string, unknown> {
  if (config.runtime.native.mode === "docker-compose") return composeRun(config, "up", component);
  const current = nativeStatus(config, component);
  if (current.state === "running") return { ...current, mutation: false, reason: "already-running" };
  const env = preparedEnvironment ?? nativeEnvironment(config, component);
  const service = config.runtime.native.services[component];
  const target = paths(config, component);
  mkdirSync(target.stateDir, { recursive: true });
  rmSync(target.pid, { force: true });
  const log = openSync(target.log, "a", 0o600);
  try {
    const child = spawn(service.command[0]!, service.command.slice(1), {
      cwd: config.rootDirectory,
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    if (!child.pid) throw new Error(`native ${component} did not return a pid`);
    writeFileSync(target.pid, `${child.pid}\n`, { encoding: "utf8", mode: 0o600 });
    child.unref();
    return { ok: true, component, state: "starting", pid: child.pid, pidFile: target.pid, logFile: target.log, mutation: true, valuesPrinted: false };
  } finally {
    closeSync(log);
  }
}

export function nativeStop(config: AppConfig, component: NativeServiceId): Record<string, unknown> {
  if (config.runtime.native.mode === "docker-compose") return composeRun(config, "stop", component);
  const target = paths(config, component);
  const pid = processId(target.pid);
  if (!running(pid)) {
    rmSync(target.pid, { force: true });
    return { ok: true, component, state: "stopped", mutation: false, reason: "already-stopped", valuesPrinted: false };
  }
  process.kill(pid!, "SIGTERM");
  rmSync(target.pid, { force: true });
  return { ok: true, component, state: "stopping", pid, mutation: true, valuesPrinted: false };
}

export function nativeLogs(config: AppConfig, component: NativeServiceId, tail: number): Record<string, unknown> {
  if (config.runtime.native.mode === "docker-compose") return composeRun(config, "logs", component, tail);
  const target = paths(config, component);
  const lines = existsSync(target.log) ? readFileSync(target.log, "utf8").split(/\r?\n/u).filter(Boolean).slice(-tail) : [];
  return { ok: true, component, logFile: target.log, lines, lineCount: lines.length, mutation: false, valuesPrinted: false };
}

export function nativeAll(
  config: AppConfig,
  action: "start" | "stop" | "status" | "logs",
  tail = 40,
): Record<string, unknown> {
  const components = action === "stop" ? [...nativeComponents].reverse() : nativeComponents;
  const results = components.map((component) =>
    action === "start" ? nativeStart(config, component)
      : action === "stop" ? nativeStop(config, component)
        : action === "status" ? nativeStatus(config, component)
          : nativeLogs(config, component, tail)
  );
  return {
    ok: results.every((result) => result.ok === true),
    component: "all",
    action,
    components: results,
    mutation: action === "start" || action === "stop"
      ? results.some((result) => result.mutation === true)
      : false,
    valuesPrinted: false,
  };
}
