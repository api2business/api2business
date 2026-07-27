import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { AppConfig, NativeServiceId } from "./config";
import { readSecret } from "./secrets";

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

export function nativeStart(config: AppConfig, component: NativeServiceId): Record<string, unknown> {
  const current = nativeStatus(config, component);
  if (current.state === "running") return { ...current, mutation: false, reason: "already-running" };
  const temporalAddress = process.env[config.temporal.addressEnv];
  if (component === "worker" && !temporalAddress) throw new Error(`native ${component} requires env ${config.temporal.addressEnv}`);
  const service = config.runtime.native.services[component];
  const target = paths(config, component);
  mkdirSync(target.stateDir, { recursive: true });
  rmSync(target.pid, { force: true });
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [targetKey, ref] of Object.entries(config.runtime.native.env)) env[targetKey] = readSecret(config, ref);
  env.APISTATE_CONFIG_PATH = config.configPath;
  env.APISTATE_RUNTIME_ID = "native";
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
