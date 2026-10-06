import { readFileSync } from "node:fs";
import { loadConfig, type HttpCliTarget } from "../../../../src/config";
import { readSecret } from "../../../../src/secrets";
import { runBoundedProcess } from "../../../../src/bounded-process";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function runWebScreenshot(
  parsed: { overApi: boolean; configPath: string; profile: string | null; scope: string | null },
  config: ReturnType<typeof loadConfig>,
  target: HttpCliTarget,
): Promise<Record<string, unknown>> {
  if (!parsed.overApi) throw new Error("web screenshot requires --over-api");
  const scheduling = config.operations.upstreamSchedulingV2;
  if (parsed.scope !== null && !scheduling?.scopes[parsed.scope]?.enabled) {
    throw new Error(`unavailable scope: ${parsed.scope}`);
  }
  const passwordRef = config.runtime.native.env.API2BUSINESS_WEB_PASSWORD;
  if (!passwordRef) throw new Error("runtime.native.env.API2BUSINESS_WEB_PASSWORD is required");
  const password = readSecret(config, passwordRef);
  const response = await fetch(new URL("/api/login", target.baseUrl), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ username: config.webAuth.username, password }),
    signal: AbortSignal.timeout(Math.min(config.monitor.cli.timeoutMs, 15_000)),
  });
  if (!response.ok) throw new Error(`Api2Business session request failed: HTTP ${response.status}`);
  const cookieHeader = response.headers.get("set-cookie") ?? "";
  const cookiePair = cookieHeader.split(";", 1)[0] ?? "";
  const separator = cookiePair.indexOf("=");
  const cookieName = separator > 0 ? cookiePair.slice(0, separator).trim() : "";
  const cookieValue = separator > 0 ? cookiePair.slice(separator + 1).trim() : "";
  if (cookieName !== config.webAuth.cookieName || cookieValue === "") {
    throw new Error(`Api2Business session response is missing ${config.webAuth.cookieName}`);
  }
  const raw = record(Bun.YAML.parse(readFileSync(parsed.configPath, "utf8"))) ?? {};
  const webProbe = record(raw.webProbe) ?? {};
  const origin = record(webProbe.origin) ?? {};
  const profileName = parsed.profile ?? String(webProbe.defaultSmokeProfile ?? "");
  if (!profileName) throw new Error("webProbe.defaultSmokeProfile is required");
  const profiles = record(webProbe.smokeProfiles) ?? {};
  const profile = record(profiles[profileName]) ?? {};
  if (!profileName || Object.keys(profile).length === 0) {
    throw new Error(`unknown webProbe smoke profile: ${profileName}`);
  }
  const originBaseUrl = typeof origin.baseUrl === "string" ? origin.baseUrl : target.baseUrl;
  const path = typeof profile.path === "string" ? profile.path : "";
  const viewport = record(profile.viewport);
  const mobileViewport = record(profile.mobileViewport);
  const readySelector = typeof profile.readySelector === "string" ? profile.readySelector : null;
  const settleMs = Number(profile.settleMs ?? 0);
  if (!path.startsWith("/") || !viewport || !mobileViewport
    || !Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height)
    || !Number.isSafeInteger(mobileViewport.width) || !Number.isSafeInteger(mobileViewport.height)
    || !Number.isSafeInteger(settleMs) || settleMs < 0) {
    throw new Error(`invalid webProbe smoke profile: ${profileName}`);
  }
  const viewportValue = `${Number(viewport.width)}x${Number(viewport.height)}`;
  const mobileViewportValue = `${Number(mobileViewport.width)}x${Number(mobileViewport.height)}`;
  const url = new URL(path, originBaseUrl);
  if (parsed.scope !== null) {
    url.searchParams.set("scope", parsed.scope);
  }
  process.stderr.write(`API2BUSINESS WEB SCREENSHOT profile=${profileName} scope=${parsed.scope ?? "default"} phase=capturing\n`);
  const probe = await runBoundedProcess([
    config.monitor.cli.executable,
    config.monitor.cli.entrypoint,
    "web-probe", "screenshot",
    "--url", url.toString(),
    "--provided-session-cookie-source", "env:API2BUSINESS_WEB_PROBE_SESSION_COOKIE",
    "--provided-session-cookie-name", config.webAuth.cookieName,
    "--viewports", `${viewportValue},${mobileViewportValue}`,
    "--settle-ms", String(settleMs),
    ...(Number.isSafeInteger(profile.commandTimeoutSeconds)
      ? ["--command-timeout-seconds", String(profile.commandTimeoutSeconds)] : []),
    ...(readySelector ? ["--wait-for-selector", readySelector] : []),
    "--json",
  ], {
    cwd: config.monitor.cli.workDir,
    env: { ...process.env, API2BUSINESS_WEB_PROBE_SESSION_COOKIE: cookieValue },
    timeoutMs: config.monitor.cli.timeoutMs,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  if (probe.stdout.includes(cookieValue) || probe.stderr.includes(cookieValue)) {
    throw new Error("WebProbe output contained session material and was blocked");
  }
  const result = parseWebProbeOutput(probe.stdout);
  if (result === null) {
    const stderr = probe.stderr.replace(/\s+/gu, " ").trim().slice(-500);
    const stdout = probe.stdout.replace(/\s+/gu, " ").trim().slice(-500);
    throw new Error(`WebProbe screenshot failed: exit=${probe.exitCode} timedOut=${probe.timedOut}${stdout ? ` stdout=${stdout}` : ""}${stderr ? ` stderr=${stderr}` : ""}`);
  }
  if (probe.exitCode !== 0 || result.ok !== true) return {
    ok: false,
    action: "web-screenshot",
    profile: profileName,
    url: url.toString(),
    scope: parsed.scope,
    process: { exitCode: probe.exitCode, timedOut: probe.timedOut },
    session: { cookieName, present: true, valuesPrinted: false },
    probe: result,
    mutation: false,
    valuesPrinted: false,
  };
  const projection = record(result.data ?? result) ?? {};
  return {
    ok: projection.ok === true,
    action: "web-screenshot",
    profile: profileName,
    url: url.toString(),
    scope: parsed.scope,
    process: { exitCode: probe.exitCode, timedOut: probe.timedOut },
    session: { cookieName, present: true, valuesPrinted: false },
    probe: projection,
    mutation: false,
    valuesPrinted: false,
  };
}

function parseWebProbeOutput(stdout: string): Record<string, unknown> | null {
  // WebProbe 的进度行与终态 JSON 可以共存；终态也可以是多行格式。
  const lines = stdout.trim().split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index]!.trim().startsWith("{")) continue;
    try {
      const result = record(JSON.parse(lines.slice(index).join("\n")));
      if (result && typeof result.ok === "boolean") return result;
    } catch { /* 继续寻找完整终态，不把进度事件当结果。 */ }
  }
  return null;
}
