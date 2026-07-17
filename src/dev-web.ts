import { resolve } from "node:path";
import { loadConfig } from "./config";
import { requiredOption } from "./runtime-args";

const config = loadConfig(requiredOption("--config"));
const runtimeId = requiredOption("--runtime");
const target = config.runtime.serverTargets[runtimeId];
if (!target) throw new Error(`runtime.serverTargets.${runtimeId} does not exist`);
const staticRoot = resolve(import.meta.dir, "../static");

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function staticName(pathname: string): string | null {
  if (pathname === "/") return "login.html";
  const value = pathname.slice(1);
  if (!["login.html", "scores.html", "ranking.html", "lottery.html", "app.js", "styles.css"].includes(value)) return null;
  return value;
}

const server = Bun.serve({
  hostname: target.webListenHost,
  port: target.webListenPort,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      const upstream = new URL(url.pathname + url.search, target.webApiBaseUrl);
      return await fetch(new Request(upstream, request));
    }
    const pageAlias = ({ "/login": "login.html", "/scores": "scores.html", "/ranking": "ranking.html", "/lottery": "lottery.html" } as Record<string, string>)[url.pathname];
    const name = pageAlias ?? staticName(url.pathname);
    if (!name) return Response.json({ ok: false, error: "not found" }, { status: 404 });
    const file = Bun.file(resolve(staticRoot, name));
    if (!(await file.exists())) return Response.json({ ok: false, error: "not found" }, { status: 404 });
    const extension = name.slice(name.lastIndexOf("."));
    return new Response(file, { headers: { "content-type": contentTypes[extension] ?? "application/octet-stream", "cache-control": "no-store" } });
  },
});

console.log(JSON.stringify({
  ok: true,
  component: "apistate-web-native",
  runtime: runtimeId,
  listen: server.url.toString(),
  apiBaseUrl: target.webApiBaseUrl,
  hotReload: true,
  valuesPrinted: false,
}));

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  server.stop(true);
  process.exit(0);
});
