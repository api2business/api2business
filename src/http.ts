import { resolve } from "node:path";
import type { AccountScoreService } from "./account-score-service";
import type { AppConfig } from "./config";
import type { LotteryService } from "./lottery-service";
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
  service: LotteryService,
  monitor: AccountScoreService,
  config: AppConfig,
  auth: WebAuthSecrets,
  legacyAdminToken: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const session = sessionAuthorized(request, config, auth);
    const apiKey = apiKeyAuthorized(request, auth) || request.headers.get("authorization") === `Bearer ${legacyAdminToken}`;
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        const scores = monitor.state();
        return json({ ok: true, service: "apistate", scoreStatus: scores.status, refreshedAt: scores.refreshedAt });
      }
      if (request.method === "POST" && url.pathname === "/api/login") {
        const input = await body(request);
        if (!validLogin(input.username, input.password, config, auth)) return json({ ok: false, error: "用户名或密码错误" }, 401);
        return json({ ok: true, username: config.webAuth.username }, 200, { "set-cookie": createSessionCookie(config, auth) });
      }
      if (request.method === "POST" && url.pathname === "/api/logout") {
        return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(config) });
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
        const scores = monitor.state();
        return json({ ok: true, service: "apistate", scoreStatus: scores.status, refreshedAt: scores.refreshedAt, nextRefreshAt: scores.nextRefreshAt });
      }
      if (request.method === "GET" && url.pathname === "/api/scores") {
        const state = monitor.state();
        return json({ ...state, snapshotOk: state.ok, ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/scores/refresh") {
        const state = await monitor.refresh();
        return json({ ...state, snapshotOk: state.ok, ok: true });
      }
      if (request.method === "GET" && url.pathname === "/api/ranking") return json({ ok: true, ranking: await service.ranking() });
      if (request.method === "GET" && url.pathname === "/api/lottery") return json(await service.publicState());
      if (request.method === "POST" && url.pathname === "/api/lottery/draw") return json({ ok: true, record: await service.publicDraw() });

      if (!url.pathname.startsWith("/api/admin/")) return json({ ok: false, error: "not found" }, 404);
      if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
      if (request.method === "GET" && url.pathname === "/api/admin/status") return json(await service.status(false));
      if (request.method === "GET" && url.pathname === "/api/admin/backend-check") return json(await service.status(true));
      if (request.method === "POST" && url.pathname === "/api/admin/draw") return json({ ok: true, record: await service.draw() });
      if (request.method === "POST" && url.pathname === "/api/admin/reset") {
        const input = await body(request);
        if (!Number.isInteger(input.draws) || Number(input.draws) < 0 || typeof input.includeRecords !== "boolean") return json({ ok: false, error: "draws must be a non-negative integer and includeRecords must be boolean" }, 400);
        return json(service.reset(Number(input.draws), input.includeRecords));
      }
      if (request.method === "GET" && url.pathname === "/api/admin/records") {
        const limit = Number(url.searchParams.get("limit"));
        if (!Number.isInteger(limit) || limit < 1) return json({ ok: false, error: "limit must be a positive integer" }, 400);
        return json({ ok: true, records: service.listRecords(limit) });
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/api/admin/records/")) return json(service.deleteRecord(decodeURIComponent(url.pathname.slice("/api/admin/records/".length))));
      if (request.method === "POST" && url.pathname === "/api/admin/credit-test") {
        const input = await body(request);
        if (typeof input.execute !== "boolean") return json({ ok: false, error: "execute must be boolean" }, 400);
        return json(await service.creditTest(input.execute));
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
