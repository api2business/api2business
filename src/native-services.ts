import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { AppConfig, NativeServiceId } from "./config";
import { readSecret } from "./secrets";

const nativeComponents: NativeServiceId[] = ["api", "worker", "web"];

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
  return config.monitor.automaticRefresh.enabled
    && config.runtime.native.services[component].envKeys.includes(
      config.temporal.addressEnv,
    );
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
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 10_000,
    });
    const address = result.stdout.trim();
    if (result.status !== 0 || !/^[0-9a-f:.]+:[1-9][0-9]*$/iu.test(address)) {
      throw new Error(`native temporal service resolution failed for ${ref.namespace}/${ref.service}`);
    }
    env[config.temporal.addressEnv] = address;
  }
  env.APISTATE_CONFIG_PATH = config.configPath;
  env.APISTATE_RUNTIME_ID = "native";
  return env;
}

export function nativeStatus(config: AppConfig, component: NativeServiceId): Record<string, unknown> {
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
