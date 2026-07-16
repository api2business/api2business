import type { LotteryService } from "./lottery-service";
import { resolve } from "node:path";

const staticRoot = resolve(import.meta.dir, "../static");

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  return await request.json().catch(() => ({})) as Record<string, unknown>;
}

function errorResponse(error: unknown, publicRequest: boolean): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = /does not exist|no draw chance|no eligible/u.test(message) ? 409 : 500;
  if (status >= 500) console.error(JSON.stringify({ ok: false, path: publicRequest ? "public" : "admin", error: message }));
  return json({ ok: false, error: publicRequest && status >= 500 ? "开奖服务暂时不可用，请稍后重试" : message }, status);
}

async function staticFile(name: string, contentType: string): Promise<Response> {
  const file = Bun.file(resolve(staticRoot, name));
  if (!(await file.exists())) return json({ ok: false, error: "not found" }, 404);
  return new Response(file, { headers: { "content-type": contentType, "cache-control": name === "index.html" ? "no-cache" : "public, max-age=300" } });
}

export function createHandler(service: LotteryService, adminToken: string): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "sub2rank" });
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") return await staticFile("index.html", "text/html; charset=utf-8");
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/styles.css") return await staticFile("styles.css", "text/css; charset=utf-8");
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/app.js") return await staticFile("app.js", "text/javascript; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/api/public/state") return json(await service.publicState());
      if (request.method === "POST" && url.pathname === "/api/public/draw") return json({ ok: true, record: await service.publicDraw() });
      if (!url.pathname.startsWith("/api/admin/")) return json({ ok: false, error: "not found" }, 404);
      if (request.headers.get("authorization") !== `Bearer ${adminToken}`) return json({ ok: false, error: "unauthorized" }, 401);
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
      return errorResponse(error, url.pathname.startsWith("/api/public/"));
    }
  };
}
