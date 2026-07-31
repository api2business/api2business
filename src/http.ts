import { resolve } from "node:path";
import type { AppConfig } from "./config";
import type { ApplicationDispatcher } from "./dispatcher";
import type { OperationsService } from "./operations-service";
import type { AccountLifecycleService, LifecycleRequest } from "./account-lifecycle-service";
import type { AccountImportService, AccountImportRequest } from "./account-import-service";
import type { AppCommand, OperationRequest } from "./contracts";
import {
  normalizeAccountIds,
  parseAccountEconomicsWindow,
} from "./account-batch-economics";
import { parseAlipayRevenueWindow } from "./alipay-revenue-database";
import { parseCompletedProfitDay } from "./daily-profit-facts";
import { normalizeExternalAccountCosts } from "./account-import-economics";
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

function positiveInteger(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function pageNumber(url: URL): number {
  const page = positiveInteger(url.searchParams.get("page"), 1);
  if (page === null) throw new Error("page must be a positive integer");
  return page;
}

function operationRequest(value: Record<string, unknown>): OperationRequest | null {
  const command = value.command as Record<string, unknown> | undefined;
  if (typeof value.operationId !== "string" || !value.operationId.trim()) return null;
  if (!command || typeof command.kind !== "string") return null;
  return {
    operationId: value.operationId,
    command: command as AppCommand,
  };
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
  operations: OperationsService,
  imports: AccountImportService,
  lifecycle: AccountLifecycleService,
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
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/score-display-freshness.js") {
        return await staticFile("score-display-freshness.js", "text/javascript; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/") return redirect(session ? "/scores" : "/login");
      const page = ({ "/scores": "scores.html", "/ranking": "ranking.html", "/lottery": "lottery.html", "/operations": "operations.html", "/account-import": "account-import.html" } as Record<string, string>)[url.pathname];
      if (page) return session ? await staticFile(page, "text/html; charset=utf-8") : redirect("/login");

      if (url.pathname.startsWith("/api/") && !session && !apiKey) return json({ ok: false, error: "unauthorized" }, 401);
      if (request.method === "GET" && url.pathname === "/api/account-import/options") return json(imports.options());
      if (request.method === "POST" && url.pathname === "/api/account-import/jobs") {
        const input = await body(request) as unknown as AccountImportRequest;
        if (typeof input.content !== "string" || typeof input.confirm !== "boolean"
          || (input.perAccountProxy !== undefined && typeof input.perAccountProxy !== "boolean")
          || (input.inputFormat !== undefined && input.inputFormat !== "json" && input.inputFormat !== "zip")
          || (input.planType !== "k12" && input.planType !== "plus" && input.planType !== "free")
          || !Number.isFinite(input.unitCostCny) || input.unitCostCny <= 0
          || Math.abs(Math.round(input.unitCostCny * 100) - input.unitCostCny * 100) > 1e-8) {
          return json({ ok: false, error: "导入参数无效：账号类型只允许 k12、plus 或 free，账号单价须为正数人民币且最多两位小数" }, 400);
        }
        return json({ ok: true, job: imports.submit(input) }, 202);
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/account-import/jobs/")) {
        const job = imports.get(decodeURIComponent(url.pathname.slice("/api/account-import/jobs/".length)));
        return job ? json({ ok: true, job }) : json({ ok: false, error: "导入作业不存在" }, 404);
      }
      if (request.method === "POST" && url.pathname === "/api/account-lifecycle/jobs") {
        const input = await body(request) as unknown as LifecycleRequest;
        try { return json({ ok: true, job: lifecycle.submit(input) }, 202); }
        catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
      }
      if (request.method === "GET" && /^\/api\/account-lifecycle\/jobs\/[^/]+$/u.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[4]!);
        const job = lifecycle.get(id);
        return job ? json({ ok: true, job }) : json({ ok: false, error: "OAuth 生命周期作业不存在" }, 404);
      }
      if (request.method === "POST" && /^\/api\/account-lifecycle\/jobs\/[^/]+\/settle$/u.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[4]!);
        try { return json({ ok: true, job: lifecycle.settle(id) }, 202); }
        catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 409); }
      }
      if (request.method === "POST" && url.pathname === "/api/admin/accounts/inspect") {
        const input = await body(request);
        return json(await imports.inspect(normalizeAccountIds(input.accountIds)));
      }
      if (request.method === "POST" && url.pathname === "/api/internal/execute-operation") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const operation = operationRequest(await body(request));
        if (!operation) return json({ ok: false, error: "invalid operation request" }, 400);
        return json({
          ok: true,
          operationId: operation.operationId,
          result: await dispatcher.executeDirect(operation.command),
        });
      }
      if (request.method === "POST" && url.pathname === "/api/internal/priority-automation/run-due") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        return json(await operations.runDueAutomation());
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        const scores = await dispatcher.dispatch({ kind: "scores.get" }) as Record<string, unknown>;
        return json({ ok: true, service: "apistate", scoreStatus: scores.status, refreshedAt: scores.refreshedAt, nextRefreshAt: scores.nextRefreshAt });
      }
      if (request.method === "GET" && url.pathname === "/api/scores") {
        const state = await dispatcher.dispatch({ kind: "scores.get" }) as Record<string, unknown>;
        return json({ ...state, availableCallOptions: config.monitor.recentCallOptions, snapshotOk: state.ok, ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/scores/refresh") {
        const state = await dispatcher.dispatch({ kind: "scores.refresh" }) as Record<string, unknown>;
        return json({ ...state, snapshotOk: state.ok, ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/scores/rank") {
        const input = await body(request);
        if (!Number.isInteger(input.recentCallLimit)) return json({ ok: false, error: "recentCallLimit must be an integer" }, 400);
        const state = await dispatcher.dispatch({
          kind: "scores.rank",
          recentCallLimit: Number(input.recentCallLimit),
          accountSelector: typeof input.accountSelector === "string" && input.accountSelector.trim()
            ? input.accountSelector.trim()
            : null,
          groupSelector: typeof input.groupSelector === "string" && input.groupSelector.trim()
            ? input.groupSelector.trim()
            : null,
        }) as Record<string, unknown>;
        return json({ ...state, ok: true });
      }
      if (request.method === "GET" && url.pathname === "/api/ranking") return json({ ok: true, ranking: await dispatcher.dispatch({ kind: "ranking.get" }) });
      if (request.method === "GET" && url.pathname === "/api/lottery") return json(await dispatcher.dispatch({ kind: "lottery.publicState" }));
      if (request.method === "POST" && url.pathname === "/api/lottery/draw") return json({ ok: true, record: await dispatcher.dispatch({ kind: "lottery.publicDraw" }) });
      if (request.method === "GET" && url.pathname === "/api/operations/ledger") {
        const period = url.searchParams.get("period") ?? undefined;
        if (period !== undefined && !/^\d{4}-\d{2}$/u.test(period)) return json({ ok: false, error: "period must be YYYY-MM" }, 400);
        try { return json(await operations.ledger(period, pageNumber(url), 10)); }
        catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
      }
      if (request.method === "GET" && url.pathname === "/api/operations/oauth-cost") {
        try {
          return json(await operations.oauthPoolEconomics());
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }
      if (request.method === "POST" && url.pathname === "/api/operations/cash") {
        const input = await body(request);
        if (!/^\\d{4}-\\d{2}-\\d{2}$/u.test(String(input.occurredOn ?? ""))
          || (input.direction !== "income" && input.direction !== "expense")
          || typeof input.category !== "string" || !input.category.trim()
          || !Number.isFinite(Number(input.amountCny)) || Number(input.amountCny) <= 0
          || typeof input.description !== "string" || !input.description.trim()) {
          return json({ ok: false, error: "经营记录字段不完整" }, 400);
        }
        return json(await operations.addCash({
          occurredOn: String(input.occurredOn),
          direction: input.direction,
          category: input.category.trim(),
          amountCny: Number(input.amountCny),
          description: input.description.trim(),
        }, config.webAuth.username));
      }
      if (request.method === "POST" && /^\/api\/operations\/cash\/[^/]+\/void$/u.test(url.pathname)) {
        const input = await body(request);
        if (typeof input.reason !== "string" || !input.reason.trim()) return json({ ok: false, error: "作废原因不能为空" }, 400);
        const id = decodeURIComponent(url.pathname.split("/")[4]!);
        return json(await operations.voidCash(id, input.reason.trim(), config.webAuth.username));
      }
      if (request.method === "POST" && url.pathname === "/api/operations/priority-plans") {
        const input = await body(request);
        const limit = Number(input.recentCallLimit ?? config.monitor.recentCallLimit);
        if (!config.monitor.recentCallOptions.includes(limit)) return json({ ok: false, error: "评分样本档位无效" }, 400);
        return json(await operations.generatePriorityPlan(limit, config.webAuth.username));
      }
      if (request.method === "GET" && url.pathname === "/api/operations/priority-state") {
        const limit = Number(url.searchParams.get("recentCallLimit") ?? config.monitor.recentCallLimit);
        if (!config.monitor.recentCallOptions.includes(limit)) return json({ ok: false, error: "评分样本档位无效" }, 400);
        return json(await operations.priorityState(
          limit,
          "manual",
          url.searchParams.get("account"),
          url.searchParams.get("group"),
        ));
      }
      if (request.method === "GET" && url.pathname === "/api/operations/priority-history") {
        return json(await operations.priorityHistory());
      }
      if (request.method === "GET" && url.pathname === "/api/operations/priority-automation") {
        return json(await operations.getPriorityAutomation());
      }
      if (request.method === "POST" && url.pathname === "/api/operations/priority-automation") {
        const input = await body(request);
        return json(await operations.createPriorityAutomation({
          enabled: input.enabled, intervalSeconds: input.intervalSeconds, recentCallLimit: input.recentCallLimit,
        }, config.webAuth.username));
      }
      if (request.method === "PATCH" && url.pathname === "/api/operations/priority-automation") {
        const input = await body(request);
        return json(await operations.updatePriorityAutomation({
          enabled: input.enabled, intervalSeconds: input.intervalSeconds, recentCallLimit: input.recentCallLimit,
        }, config.webAuth.username));
      }
      if (request.method === "DELETE" && url.pathname === "/api/operations/priority-automation") {
        return json(await operations.deletePriorityAutomation(config.webAuth.username));
      }
      if (request.method === "POST" && /^\/api\/operations\/priority-plans\/[^/]+\/confirm$/u.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[4]!);
        return json(await operations.confirmPriorityPlan(id, config.webAuth.username));
      }
      if (request.method === "POST" && url.pathname === "/api/operations/procurement") {
        const input = await body(request);
        const budget = Number(input.budgetCny);
        if (!Number.isInteger(budget) || budget <= 0) return json({ ok: false, error: "预算必须为正整数" }, 400);
        const page = positiveInteger(String(input.page ?? "1"), 1);
        if (page === null) return json({ ok: false, error: "page must be a positive integer" }, 400);
        return json(await operations.procurement(budget, config.webAuth.username, page, 10));
      }
      if (request.method === "GET" && url.pathname === "/api/operations/audits") {
        try { return json(await operations.audits(pageNumber(url), 10)); }
        catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
      }
      if (request.method === "GET" && url.pathname === "/api/admin/read-status") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        return json(operations.readStatus());
      }
      if (request.method === "GET" && url.pathname === "/api/admin/errors/aggregate") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const limit = positiveInteger(
          url.searchParams.get("limit"),
          config.monitor.errorAggregateLimit,
        );
        const top = positiveInteger(
          url.searchParams.get("top"),
          config.monitor.errorAggregateTop,
        );
        if (limit === null || top === null) {
          return json({ ok: false, error: "limit and top must be positive integers" }, 400);
        }
        return json(await operations.errorAggregate(
          limit,
          top,
          url.searchParams.get("account"),
          url.searchParams.get("group"),
        ));
      }
      if (request.method === "GET" && url.pathname === "/api/admin/errors") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const limit = positiveInteger(
          url.searchParams.get("limit"),
          config.monitor.errorAggregateLimit,
        );
        if (limit === null) return json({ ok: false, error: "limit must be a positive integer" }, 400);
        return json(await operations.errorList(limit));
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/admin/errors/")) {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const requestId = decodeURIComponent(url.pathname.slice("/api/admin/errors/".length));
        if (!requestId) return json({ ok: false, error: "request id is required" }, 400);
        return json(await operations.errorRequest(requestId));
      }
      if (request.method === "POST" && url.pathname === "/api/admin/users/impact") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const input = await body(request);
        if (
          typeof input.start !== "string"
          || typeof input.end !== "string"
          || typeof input.affectedOnly !== "boolean"
        ) {
          return json({
            ok: false,
            error: "start, end, and affectedOnly are required",
          }, 400);
        }
        return json(await operations.userImpact(
          input.start,
          input.end,
          input.affectedOnly,
        ));
      }
      if (request.method === "POST" && url.pathname === "/api/admin/accounts/economics") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const input = await body(request);
        const costCny = Number(input.costCny);
        let accountIds: number[];
        try {
          accountIds = normalizeAccountIds(input.accountIds);
          if (!Number.isFinite(costCny) || costCny <= 0) throw new Error("costCny must be a positive number");
          parseAccountEconomicsWindow({
            day: typeof input.day === "string" ? input.day : null,
            start: typeof input.start === "string" ? input.start : null,
            end: typeof input.end === "string" ? input.end : null,
          }, config.monitor.timezone);
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
        return json(await operations.accountBatchEconomics({
          accountIds,
          costCny,
          day: typeof input.day === "string" ? input.day : null,
          start: typeof input.start === "string" ? input.start : null,
          end: typeof input.end === "string" ? input.end : null,
        }));
      }
      if (request.method === "POST" && url.pathname === "/api/admin/accounts/import-economics") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const input = await body(request);
        try {
          if (typeof input.day !== "string") throw new Error("day is required");
          parseAccountEconomicsWindow({ day: input.day }, config.monitor.timezone);
          const externalCosts = normalizeExternalAccountCosts(input.externalCosts);
          return json(await operations.accountImportEconomics({ day: input.day, externalCosts }));
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }
      if (request.method === "POST" && url.pathname === "/api/admin/accounts/oauth-economics") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        try {
          return json(await operations.oauthPoolEconomics());
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }
      if (request.method === "POST" && url.pathname === "/api/admin/payments/alipay-revenue") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const input = await body(request);
        const windowInput = {
          day: typeof input.day === "string" ? input.day : null,
          period: typeof input.period === "string" ? input.period : null,
        };
        try {
          parseAlipayRevenueWindow(windowInput, config.monitor.timezone);
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
        return json(await operations.alipayRevenue(windowInput));
      }
      if (request.method === "GET" && url.pathname === "/api/admin/users/balance-liability") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        return json(await operations.userBalanceLiability());
      }
      if (request.method === "POST" && url.pathname === "/api/admin/profit/daily-facts") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const input = await body(request);
        if (typeof input.day !== "string") return json({ ok: false, error: "day is required" }, 400);
        try {
          parseCompletedProfitDay(input.day, config.monitor.timezone);
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
        return json(await operations.dailyProfitFacts(input.day));
      }

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
