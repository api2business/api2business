import { resolve } from "node:path";
import type { AppConfig } from "./config";
import type { ApplicationDispatcher } from "./dispatcher";
import {
  apiKeyAuthorized,
  clearSessionCookie,
  createSessionCookie,
  sessionAuthorized,
  validLogin,
  type WebAuthSecrets,
} from "./web-auth";

const staticRoot = resolve(import.meta.dir, "../static");

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  return await request.json().catch(() => ({})) as Record<string, unknown>;
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = /does not exist|no draw chance|no eligible/u.test(message) ? 409 : 500;
  if (status >= 500) console.error(JSON.stringify({ ok: false, component: "http", error: message }));
  return json({ ok: false, error: status >= 500 ? "服务暂时不可用，请稍后重试" : message }, status);
}

async function staticFile(name: string, contentType: string): Promise<Response> {
  const file = Bun.file(resolve(staticRoot, name));
  if (!(await file.exists())) return json({ ok: false, error: "not found" }, 404);
  return new Response(file, {
    headers: {
      "content-type": contentType,
      "cache-control": name.endsWith(".html") ? "no-cache" : "public, max-age=300",
    },
  });
}

export function createHandler(
  dispatcher: ApplicationDispatcher,
  config: AppConfig,
  auth: WebAuthSecrets,
  legacyAdminToken: string,
  secureCookies: boolean,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const session = sessionAuthorized(request, config, auth);
    const apiKey = apiKeyAuthorized(request, auth) || request.headers.get("authorization") === `Bearer ${legacyAdminToken}`;
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        const scores = await dispatcher.dispatch({ kind: "scores.get" }) as Record<string, unknown>;
        return json({ ok: true, service: "apistate-api", scoreStatus: scores.status, refreshedAt: scores.refreshedAt });
      }
      if (request.method === "POST" && url.pathname === "/api/login") {
        const input = await body(request);
        if (!validLogin(input.username, input.password, config, auth)) return json({ ok: false, error: "用户名或密码错误" }, 401);
        return json({ ok: true, username: config.webAuth.username }, 200, { "set-cookie": createSessionCookie(config, auth, secureCookies) });
      }
      if (request.method === "POST" && url.pathname === "/api/logout") {
        return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(config, secureCookies) });
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/login") {
        return session ? redirect("/scores") : await staticFile("login.html", "text/html; charset=utf-8");
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/styles.css") return await staticFile("styles.css", "text/css; charset=utf-8");
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/app.js") return await staticFile("app.js", "text/javascript; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/") return redirect(session ? "/scores" : "/login");
      const page = ({ "/scores": "scores.html", "/ranking": "ranking.html", "/lottery": "lottery.html" } as Record<string, string>)[url.pathname];
      if (page) return session ? await staticFile(page, "text/html; charset=utf-8") : redirect("/login");

      if (url.pathname.startsWith("/api/") && !session && !apiKey) return json({ ok: false, error: "unauthorized" }, 401);
      if (request.method === "GET" && url.pathname === "/api/status") {
        const scores = await dispatcher.dispatch({ kind: "scores.get" }) as Record<string, unknown>;
        return json({ ok: true, service: "apistate", scoreStatus: scores.status, refreshedAt: scores.refreshedAt, nextRefreshAt: scores.nextRefreshAt });
      }
      if (request.method === "GET" && url.pathname === "/api/scores") {
        const state = await dispatcher.dispatch({ kind: "scores.get" }) as Record<string, unknown>;
        return json({ ...state, snapshotOk: state.ok, ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/scores/refresh") {
        const state = await dispatcher.dispatch({ kind: "scores.refresh" }) as Record<string, unknown>;
        return json({ ...state, snapshotOk: state.ok, ok: true });
      }
      if (request.method === "GET" && url.pathname === "/api/ranking") return json({ ok: true, ranking: await dispatcher.dispatch({ kind: "ranking.get" }) });
      if (request.method === "GET" && url.pathname === "/api/lottery") return json(await dispatcher.dispatch({ kind: "lottery.publicState" }));
      if (request.method === "POST" && url.pathname === "/api/lottery/draw") return json({ ok: true, record: await dispatcher.dispatch({ kind: "lottery.publicDraw" }) });

      if (!url.pathname.startsWith("/api/admin/")) return json({ ok: false, error: "not found" }, 404);
      if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
      if (request.method === "GET" && url.pathname === "/api/admin/status") return json(await dispatcher.dispatch({ kind: "lottery.status" }));
      if (request.method === "GET" && url.pathname === "/api/admin/backend-check") return json(await dispatcher.dispatch({ kind: "backend.check" }));
      if (request.method === "POST" && url.pathname === "/api/admin/draw") return json(await dispatcher.dispatch({ kind: "lottery.draw" }));
      if (request.method === "POST" && url.pathname === "/api/admin/reset") {
        const input = await body(request);
        if (!Number.isInteger(input.draws) || Number(input.draws) < 0 || typeof input.includeRecords !== "boolean") return json({ ok: false, error: "draws must be a non-negative integer and includeRecords must be boolean" }, 400);
        return json(await dispatcher.dispatch({ kind: "lottery.reset", draws: Number(input.draws), includeRecords: input.includeRecords }));
      }
      if (request.method === "GET" && url.pathname === "/api/admin/records") {
        const limit = Number(url.searchParams.get("limit"));
        if (!Number.isInteger(limit) || limit < 1) return json({ ok: false, error: "limit must be a positive integer" }, 400);
        return json(await dispatcher.dispatch({ kind: "records.list", limit }));
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/api/admin/records/")) return json(await dispatcher.dispatch({ kind: "records.delete", id: decodeURIComponent(url.pathname.slice("/api/admin/records/".length)) }));
      if (request.method === "POST" && url.pathname === "/api/admin/workflows") {
        const input = await body(request);
        const command = input.command as Record<string, unknown> | undefined;
        if (command?.kind !== "scores.refresh") return json({ ok: false, error: "command.kind must be scores.refresh" }, 400);
        return json(await dispatcher.submit({ kind: "scores.refresh" }));
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/admin/workflows/")) {
        const workflowId = decodeURIComponent(url.pathname.slice("/api/admin/workflows/".length));
        if (!workflowId) return json({ ok: false, error: "workflow id is required" }, 400);
        return json(await dispatcher.workflowStatus(workflowId));
      }
      if (request.method === "POST" && url.pathname === "/api/admin/credit-test") {
        const input = await body(request);
        if (typeof input.execute !== "boolean") return json({ ok: false, error: "execute must be boolean" }, 400);
        return json(await dispatcher.dispatch({ kind: "credit.test", execute: input.execute }));
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
