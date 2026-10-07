import { readFileSync } from "node:fs";
import { loadConfig, type HttpCliTarget } from "../../../../src/config";
import { readSecret } from "../../../../src/secrets";
import { runBoundedProcess } from "../../../../src/bounded-process";
import { createSessionCookie } from "../../../../src/web-auth";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function webScreenshotHelp(): Record<string, unknown> {
  return {
    command: "web screenshot",
    usage: "bun skills/api2business/scripts/api2business-cli.ts --config config/api2business.yaml --over-api web screenshot [options]",
    options: {
      "--profile": "owning YAML 的截图 profile；省略时使用 defaultSmokeProfile",
      "--id": "巡检页读取冻结报告 ID；用于复验同一窗口",
      "--account": "巡检页筛选包含此账号的钱包",
      "--scope": "已启用的 codex、claude 或 grok 作用域",
      "--session-ttl-seconds": "独立验收会话的正整数期限，必须短于部署配置；省略时使用正式登录会话",
      "--burst-count": "同页截图 1..30 帧；多帧使用 profile 的桌面视口",
      "--burst-interval": "帧间隔 200ms..10s；默认 1s",
      "--manifest": "完整原始事件的绝对文件路径",
      "--json": "结构化回执；Cookie 和 Secret 不输出",
    },
    evidence: "默认回执保留有界失败请求；截图与原始事件不自动判定业务成功",
  };
}

export async function runWebScreenshot(
  parsed: {
    overApi: boolean; configPath: string; profile: string | null; scope: string | null;
    id?: string | null; account?: string | null;
    sessionTtlSeconds?: number | null; burstCount?: number | null;
    burstInterval?: string | null; manifest?: string | null;
  },
  config: ReturnType<typeof loadConfig>,
  target: HttpCliTarget,
): Promise<Record<string, unknown>> {
  if (!parsed.overApi) throw new Error("web screenshot requires --over-api");
  const burstCount = parsed.burstCount ?? 1;
  if (!Number.isSafeInteger(burstCount) || burstCount < 1 || burstCount > 30) throw new Error("--burst-count must be from 1 to 30");
  const burstInterval = parsed.burstInterval ?? "1s";
  const intervalMatch = /^([1-9]\d*)(ms|s|m)$/u.exec(burstInterval);
  const intervalMs = intervalMatch ? Number(intervalMatch[1]) * (intervalMatch[2] === "ms" ? 1 : intervalMatch[2] === "s" ? 1000 : 60000) : NaN;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 200 || intervalMs > 10000) throw new Error("--burst-interval must be from 200ms to 10s");
  const sessionTtlSeconds = parsed.sessionTtlSeconds ?? null;
  if (sessionTtlSeconds !== null && (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds <= 0 || sessionTtlSeconds >= config.webAuth.sessionTtlSeconds)) {
    throw new Error("--session-ttl-seconds must be positive and shorter than webAuth.sessionTtlSeconds");
  }
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
  let cookieValue = separator > 0 ? cookiePair.slice(separator + 1).trim() : "";
  if (cookieName !== config.webAuth.cookieName || cookieValue === "") {
    throw new Error(`Api2Business session response is missing ${config.webAuth.cookieName}`);
  }
  if (sessionTtlSeconds !== null) {
    const sessionRef = config.runtime.native.env.API2BUSINESS_SESSION_SECRET;
    if (!sessionRef) throw new Error("runtime.native.env.API2BUSINESS_SESSION_SECRET is required for a short-lived screenshot session");
    const sessionSecret = readSecret(config, sessionRef);
    const fixture = { ...config, webAuth: { ...config.webAuth, sessionTtlSeconds } };
    cookieValue = createSessionCookie(fixture, { password: "", apiKey: "", sessionSecret }, true)
      .split(";", 1)[0]!.slice(cookieName.length + 1);
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
  if (url.pathname === "/observability") {
    if (parsed.id) url.searchParams.set("report",parsed.id);
    if (parsed.account) url.searchParams.set("account",parsed.account);
  }
  if (parsed.scope !== null) {
    url.searchParams.set("scope", parsed.scope);
  }
  const startedAt = Date.now();
  const progress = () => process.stderr.write(`API2BUSINESS WEB SCREENSHOT profile=${profileName} scope=${parsed.scope ?? "default"} phase=capturing elapsedMs=${Date.now() - startedAt}\n`);
  progress();
  const heartbeat = setInterval(progress, 5000);
  const probe = await runBoundedProcess([
    config.monitor.cli.executable,
    config.monitor.cli.entrypoint,
    "web-probe", "screenshot",
    "--url", url.toString(),
    "--provided-session-cookie-source", "env:API2BUSINESS_WEB_PROBE_SESSION_COOKIE",
    "--provided-session-cookie-name", config.webAuth.cookieName,
    ...(burstCount > 1 ? ["--viewport", viewportValue, "--burst-count", String(burstCount), "--burst-interval", burstInterval]
      : ["--viewports", `${viewportValue},${mobileViewportValue}`]),
    ...(parsed.manifest ? ["--manifest", parsed.manifest] : []),
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
  }).finally(() => clearInterval(heartbeat));
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
    session: { cookieName, present: true, ttlSeconds: sessionTtlSeconds ?? config.webAuth.sessionTtlSeconds, fixture: sessionTtlSeconds !== null, valuesPrinted: false },
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
    session: { cookieName, present: true, ttlSeconds: sessionTtlSeconds ?? config.webAuth.sessionTtlSeconds, fixture: sessionTtlSeconds !== null, valuesPrinted: false },
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
