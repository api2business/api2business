import { resolve } from "node:path";
import type { AppConfig } from "./config";
import type { ApplicationDispatcher } from "./dispatcher";
import type { OperationsService } from "./operations-service";
import type { AccountLifecycleService, LifecycleJobPatch, LifecycleRequest } from "./account-lifecycle-service";
import type { AccountImportService, ImportJobPatch, AccountImportRequest } from "./account-import-service";
import { UpstreamManagementError, type UpstreamManagementService } from "./upstream-management";
import type { AppCommand, OperationRequest } from "./contracts";
import { normalizeManualPriorityAssignments } from "./manual-priority-plan";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import type { Sub2ApiRuntimeService } from "./sub2api-runtime-service";
import { TemporalSubmissionError } from "./temporal-client";
import {
  normalizeAccountIds,
  parseAccountEconomicsWindow,
} from "./account-batch-economics";
import { parseAlipayRevenueWindow } from "./alipay-revenue-database";
import { parseCompletedProfitDay } from "./daily-profit-facts";
import { normalizeExternalAccountCosts } from "./account-import-economics";
import { createHash } from "node:crypto";
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

function errorResponse(error: unknown, request?: Request): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UpstreamManagementError) {
    return json({ ok: false, error: message, ...error.details }, error.status);
  }
  const status = /does not exist|no draw chance|no eligible/u.test(message)
    ? 409
    : /base_url|API key|后缀|费率|充值金额|幂等键|字段不能为空|当前账号缺少|JSON|ZIP|去重后的账号数量|账号数量/u.test(message)
    ? 400
    : 500;
  if (status >= 500) console.error(JSON.stringify({
    ok: false,
    component: "http",
    method: request?.method ?? null,
    path: request ? new URL(request.url).pathname : null,
    error: message,
    details: error instanceof TemporalSubmissionError ? error.details : undefined,
  }));
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
      "cache-control": "no-cache",
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
  upstreams: UpstreamManagementService,
  reads: Sub2ApiReadClient,
  runtime: Sub2ApiRuntimeService,
): (request: Request) => Promise<Response> {
  const cacheKey = (request: Request) => createHash("sha256").update(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`).digest("hex");
  const cacheable = (request: Request) => request.method === "GET"
    && new URL(request.url).pathname.startsWith("/api/")
    && !/\/jobs(?:\/|$)|\/workflows(?:\/|$)|\/benchmarks(?:\/|$)|\/status$|\/health$/u.test(new URL(request.url).pathname);
  const cacheRefreshes = new Set<string>();
  const handle = async (request: Request) => {
    const url = new URL(request.url);
    const session = sessionAuthorized(request, config, auth);
      const apiKey = apiKeyAuthorized(request, auth) || request.headers.get("authorization") === `Bearer ${legacyAdminToken}`;
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "api2business-api" });
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
      const page = ({ "/scores": "scores.html", "/ranking": "ranking.html", "/lottery": "lottery.html", "/operations": "operations.html", "/oauth-cost": "oauth-cost.html", "/account-import": "account-import.html", "/upstreams": "upstreams.html" } as Record<string, string>)[url.pathname];
      if (page) return session ? await staticFile(page, "text/html; charset=utf-8") : redirect("/login");

      if (url.pathname.startsWith("/api/") && !session && !apiKey) return json({ ok: false, error: "unauthorized" }, 401);
      if (request.method === "GET" && url.pathname === "/api/upstreams/options") {
        return json(upstreams.options());
      }
      if (request.method === "GET" && /^\/api\/upstreams\/jobs\/[^/]+$/u.test(url.pathname)) {
        const workflowId = decodeURIComponent(url.pathname.split("/")[4]!);
        return json(await upstreams.workflowStatus(workflowId));
      }
      if (request.method === "GET" && url.pathname === "/api/upstreams") {
        const page = pageNumber(url);
        return json(await upstreams.list(page, url.searchParams.get("search")));
      }
      if (request.method === "GET" && url.pathname === "/api/upstreams/benchmarks") {
        const selector = url.searchParams.get("accountIds");
        const accountIds = selector ? normalizeAccountIds(selector.split(",")) : [];
        return json(await operations.upstreamBenchmarks(accountIds));
      }
      if (request.method === "GET" && /^\/api\/upstreams\/benchmarks\/[^/]+$/u.test(url.pathname)) {
        return json(await operations.upstreamBenchmarkDetail(decodeURIComponent(url.pathname.split("/")[4]!)));
      }
      if (request.method === "GET" && /^\/api\/upstreams\/\d+\/benchmarks$/u.test(url.pathname)) {
        const accountId = Number(url.pathname.split("/")[3]);
        const limit = positiveInteger(url.searchParams.get("limit"), 20);
        if (!Number.isSafeInteger(accountId) || accountId <= 0 || limit === null || limit > 100) return json({ ok: false, error: "invalid benchmark history query" }, 400);
        return json(await operations.upstreamBenchmarkHistory(accountId, limit));
      }
      if (request.method === "POST" && /^\/api\/upstreams\/\d+\/benchmark$/u.test(url.pathname)) {
        const accountId = Number(url.pathname.split("/")[3]);
        if (!Number.isSafeInteger(accountId) || accountId <= 0) return json({ ok: false, error: "account id is invalid" }, 400);
        const input = await body(request);
        const model = typeof input.model === "string" && input.model.trim()
          ? input.model.trim()
          : config.operations.upstreamBenchmark.model;
        const created = await operations.createUpstreamBenchmark(accountId, model);
        try {
          const submitted = await dispatcher.submit({ kind: "upstream.benchmark", benchmarkRunId: created.runId, accountId, model: created.model });
          return json({ ...submitted as Record<string, unknown>, benchmarkRunId: created.runId }, 202);
        } catch (error) {
          await operations.failUpstreamBenchmarkSubmission(created.runId, error);
          throw error;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/upstreams/usage-cache") {
        const selector = url.searchParams.get("accountIds");
        const accountIds = selector ? normalizeAccountIds(selector.split(",")) : [];
        const rows = await operations.getUpstreamUsageCache(accountIds) as Array<Record<string, unknown>>;
        return json({
          ok: true,
          results: rows.map((row) => row.result),
          cachedAt: rows.map((row) => row.queried_at),
          lastSuccessfulResults: rows.map((row) => row.last_success_result),
          lastSuccessfulAt: rows.map((row) => row.last_success_at),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/upstreams/quota-summary") {
        return json(await operations.upstreamQuotaSummary());
      }
      if (request.method === "GET" && url.pathname === "/api/upstreams/pool-quality") {
        return json(await operations.poolQualitySummary());
      }
      if (request.method === "GET" && url.pathname === "/api/oauth/runtime-summary") {
        const profile = url.searchParams.get("profile") ?? "codex";
        if (profile !== "codex" && profile !== "grok") {
          return json({ ok: false, error: "profile must be codex or grok" }, 400);
        }
        return json(await operations.oauthRuntimeSummary(profile));
      }
      if (request.method === "POST" && url.pathname === "/api/upstreams/usage-cache/restore") {
        try { return json(await operations.restoreUpstreamUsageSuccess(await body(request))); }
        catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
      }
      if (request.method === "POST" && url.pathname === "/api/upstreams/usage") {
        const input = await body(request);
        let accountIds: number[] = [];
        try {
          if (Array.isArray(input.accountIds) && input.accountIds.length > 0) accountIds = normalizeAccountIds(input.accountIds);
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
        return json(await upstreams.submitUsage(
          accountIds,
          typeof input.operationId === "string" ? input.operationId : request.headers.get("idempotency-key"),
        ), 202);
      }
      if (request.method === "POST" && url.pathname === "/api/upstreams/template") {
        const input = await body(request);
        let accountIds: number[] = [];
        try {
          if (Array.isArray(input.accountIds) && input.accountIds.length > 0) accountIds = normalizeAccountIds(input.accountIds);
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
        return json(await upstreams.submitTemplate(
          accountIds,
          typeof input.operationId === "string" ? input.operationId : request.headers.get("idempotency-key"),
        ), 202);
      }
      if (request.method === "POST" && url.pathname === "/api/upstreams/isolation") {
        const input = await body(request);
        let accountIds: number[] = [];
        try {
          if (Array.isArray(input.accountIds)) accountIds = normalizeAccountIds(input.accountIds);
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
        if (accountIds.length === 0) return json({ ok: false, error: "accountIds 不能为空" }, 400);
        return json(await upstreams.submitIsolation(
          accountIds,
          typeof input.operationId === "string" ? input.operationId : request.headers.get("idempotency-key"),
        ), 202);
      }
      if (request.method === "POST" && url.pathname === "/api/upstreams") {
        const input = await body(request);
        if (typeof input.baseUrl !== "string" || typeof input.apiKey !== "string"
          || typeof input.suffix !== "string" || input.apiKey.trim() === "") {
          return json({ ok: false, error: "base_url、API key 和后缀不能为空" }, 400);
        }
        return json(await upstreams.submitCreate({
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          suffix: input.suffix,
          rateCnyPerApiUsd: input.rateCnyPerApiUsd,
          rechargeCny: input.rechargeCny,
          priority: input.priority,
          capacity: input.capacity,
          groupIds: input.groupIds,
          operationId: typeof input.operationId === "string" ? input.operationId : request.headers.get("idempotency-key"),
          description: typeof input.description === "string" ? input.description : undefined,
        }), 202);
      }
      if (request.method === "PATCH" && /^\/api\/upstreams\/[1-9]\d*$/u.test(url.pathname)) {
        const id = Number(url.pathname.split("/")[3]);
        const input = await body(request);
        return json(await upstreams.submitUpdate(id, {
          suffix: input.suffix,
          rateCnyPerApiUsd: input.rateCnyPerApiUsd,
          operationId: typeof input.operationId === "string" ? input.operationId : request.headers.get("idempotency-key"),
        }));
      }
      if (request.method === "POST" && /^\/api\/upstreams\/[1-9]\d*\/recharge$/u.test(url.pathname)) {
        const id = Number(url.pathname.split("/")[3]);
        const input = await body(request);
        return json(await upstreams.submitRecharge(id, {
          amountCny: input.amountCny,
          operationId: typeof input.operationId === "string" ? input.operationId : request.headers.get("idempotency-key"),
          description: typeof input.description === "string" ? input.description : undefined,
        }));
      }
      if (request.method === "GET" && url.pathname === "/api/account-import/options") return json(imports.options());
      if (request.method === "POST" && url.pathname === "/api/account-import/preview") {
        const input = await body(request);
        if (typeof input.content !== "string" || (input.inputFormat !== "json" && input.inputFormat !== "zip")) {
          return json({ ok: false, error: "导入预览需要 JSON 或 ZIP 内容" }, 400);
        }
        try { return json(imports.preview({ content: input.content, inputFormat: input.inputFormat })); }
        catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
      }
      if (request.method === "POST" && url.pathname === "/api/account-import/jobs") {
        const input = await body(request) as unknown as AccountImportRequest;
        if (typeof input.content !== "string" || typeof input.confirm !== "boolean"
          || (input.perAccountProxy !== undefined && typeof input.perAccountProxy !== "boolean")
          || (input.inputFormat !== undefined && input.inputFormat !== "json" && input.inputFormat !== "zip")
          || (input.planType !== "k12" && input.planType !== "plus" && input.planType !== "team" && input.planType !== "free")
          || !Number.isFinite(input.unitCostCny) || input.unitCostCny <= 0
          || Math.abs(Math.round(input.unitCostCny * 100) - input.unitCostCny * 100) > 1e-8) {
          return json({ ok: false, error: "导入参数无效：账号类型只允许 k12、plus、team 或 free，账号单价须为正数人民币且最多两位小数" }, 400);
        }
        return json({ ok: true, job: await imports.submit(input) }, 202);
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/account-import/jobs/")) {
        const job = imports.get(decodeURIComponent(url.pathname.slice("/api/account-import/jobs/".length)));
        return job ? json({ ok: true, job }) : json({ ok: false, error: "导入作业不存在" }, 404);
      }
      if (request.method === "POST" && url.pathname === "/api/account-lifecycle/jobs") {
        const input = await body(request) as unknown as LifecycleRequest;
        try { return json({ ok: true, job: await lifecycle.submit(input) }, 202); }
        catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
      }
      if (request.method === "GET" && /^\/api\/account-lifecycle\/jobs\/[^/]+$/u.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[4]!);
        const job = lifecycle.get(id);
        return job ? json({ ok: true, job }) : json({ ok: false, error: "OAuth 生命周期作业不存在" }, 404);
      }
      if (request.method === "POST" && /^\/api\/account-lifecycle\/jobs\/[^/]+\/settle$/u.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[4]!);
        try { return json({ ok: true, job: await lifecycle.settle(id) }, 202); }
        catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 409); }
      }
      if (request.method === "POST" && url.pathname === "/api/admin/accounts/inspect") {
        const input = await body(request);
        return json(await imports.inspect(normalizeAccountIds(input.accountIds)));
      }
      if (request.method === "POST" && url.pathname === "/api/admin/accounts/delete") {
        const input = await body(request);
        const accountIds = normalizeAccountIds(input.accountIds);
        if (input.confirm !== true) return json({ ok: true, mutation: false, accountIds, hint: "confirm=true 才会执行删除" });
        const result = await runtime.deleteAccounts(accountIds, config.operations.accountLifecycle.deleteTimeoutMs);
        return json({ ok: true, mutation: true, ...result });
      }
      if (request.method === "POST" && url.pathname === "/api/internal/sub2api-read") {
        const input = await body(request);
        if (typeof input.key !== "string" || typeof input.kind !== "string" || typeof input.sql !== "string"
          || !Array.isArray(input.parameters)) {
          return json({ ok: false, error: "invalid Sub2API read request" }, 400);
        }
        return json(await reads.query({
          key: input.key,
          kind: input.kind,
          sql: input.sql,
          parameters: input.parameters,
          priority: input.priority === "automatic" ? "automatic" : "manual",
          cacheMode: input.cacheMode === "prefer-cache" ? "prefer-cache" : "bypass-cache",
          setupStatements: Array.isArray(input.setupStatements)
            ? input.setupStatements.filter((value): value is string => typeof value === "string")
            : undefined,
        }));
      }
      if (request.method === "GET" && /^\/api\/internal\/upstream-operations\/[^/]+$/u.test(url.pathname)) {
        const operationId = decodeURIComponent(url.pathname.split("/")[4]!);
        const operation = upstreams.claimOperation(operationId);
        return operation
          ? json({ ok: true, operationId, operation, valuesPrinted: false })
          : json({ ok: false, error: "上游作业不存在或已过期" }, 404);
      }
      if (request.method === "POST" && /^\/api\/internal\/upstream-operations\/[^/]+\/complete$/u.test(url.pathname)) {
        const operationId = decodeURIComponent(url.pathname.split("/")[4]!);
        return json(upstreams.completeOperation(operationId));
      }
      if (request.method === "POST" && url.pathname === "/api/internal/upstream-usage-cache") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const input = await body(request);
        if (!Array.isArray(input.results)) return json({ ok: false, error: "results must be an array" }, 400);
        await operations.setUpstreamUsageCache(
          input.results as Array<Record<string, unknown>>,
          Number.isFinite(Number(input.apiAmountUsdTotal)) ? Number(input.apiAmountUsdTotal) : null,
          input.recordSample === true,
        );
        return json({ ok: true, cached: input.results.length, valuesPrinted: false });
      }
      if (request.method === "GET" && /^\/api\/internal\/account-import-jobs\/[^/]+$/u.test(url.pathname)) {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const id = decodeURIComponent(url.pathname.split("/")[4]!);
        const job = imports.workerGet(id);
        return job ? json({ ok: true, job, valuesPrinted: false }) : json({ ok: false, error: "导入作业不存在" }, 404);
      }
      if (request.method === "POST" && /^\/api\/internal\/account-import-jobs\/[^/]+$/u.test(url.pathname)) {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const id = decodeURIComponent(url.pathname.split("/")[4]!);
        return json(imports.applyWorkerPatch(id, await body(request) as ImportJobPatch));
      }
      if (request.method === "GET" && /^\/api\/internal\/account-lifecycle-jobs\/[^/]+$/u.test(url.pathname)) {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const id = decodeURIComponent(url.pathname.split("/")[4]!);
        const job = lifecycle.workerGet(id);
        return job ? json({ ok: true, job, valuesPrinted: false }) : json({ ok: false, error: "OAuth 生命周期作业不存在" }, 404);
      }
      if (request.method === "POST" && /^\/api\/internal\/account-lifecycle-jobs\/[^/]+$/u.test(url.pathname)) {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const id = decodeURIComponent(url.pathname.split("/")[4]!);
        return json(lifecycle.applyWorkerPatch(id, await body(request) as LifecycleJobPatch));
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
        return json({ ok: true, due: false, skipped: true, reason: "priority automation is owned by Temporal worker" });
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        const scores = await dispatcher.dispatch({ kind: "scores.get" }) as Record<string, unknown>;
        return json({ ok: true, service: "api2business", scoreStatus: scores.status, refreshedAt: scores.refreshedAt, nextRefreshAt: scores.nextRefreshAt });
      }
      if (request.method === "GET" && url.pathname === "/api/scores") {
        const state = await dispatcher.dispatch({ kind: "scores.get" }) as Record<string, unknown>;
        return json({ ...state, availableCallOptions: config.monitor.recentCallOptions, snapshotOk: state.ok, ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/scores/refresh") {
        return json(await dispatcher.submit({ kind: "scores.refresh" }), 202);
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
      if (request.method === "GET" && url.pathname === "/api/operations/idle-probe") {
        const selector = url.searchParams.get("accountIds");
        const accountIds = selector ? normalizeAccountIds(selector.split(",")) : [];
        return json(await operations.idleProbePlan(accountIds));
      }
      if (request.method === "GET" && url.pathname === "/api/operations/idle-probe/summary") {
        return json({ ok: true, rolling24Hours: await operations.idleProbeRollingUsage() });
      }
      if (request.method === "GET" && url.pathname === "/api/operations/idle-probe/history") {
        return json(await operations.idleProbeHistory(pageNumber(url), 10));
      }
      if (request.method === "POST" && url.pathname === "/api/operations/idle-probe") {
        const input = await body(request);
        const accountIds = Array.isArray(input.accountIds) && input.accountIds.length > 0
          ? normalizeAccountIds(input.accountIds)
          : [];
        const rounds = Number(input.rounds ?? 1);
        if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) {
          return json({ ok: false, error: "rounds must be an integer from 1 to 10" }, 400);
        }
        return json(await dispatcher.submit({ kind: "account.idle-probe.run", accountIds, rounds }), 202);
      }
      if (request.method === "POST" && url.pathname === "/api/operations/idle-probe/reconcile") {
        const input = await body(request);
        const accountIds = Array.isArray(input.accountIds) && input.accountIds.length > 0
          ? normalizeAccountIds(input.accountIds)
          : [];
        return json(await dispatcher.submit({ kind: "account.idle-probe.reconcile", accountIds }), 202);
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
          const archivedPage = positiveInteger(url.searchParams.get("archivedPage"), 1);
          if (archivedPage === null) return json({ ok: false, error: "archivedPage must be a positive integer" }, 400);
          const profile = url.searchParams.get("profile") ?? "codex";
          if (profile !== "codex" && profile !== "grok") return json({ ok: false, error: "profile must be codex or grok" }, 400);
          return json(await operations.oauthPoolEconomics(pageNumber(url), 10, archivedPage, profile));
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }
      if (request.method === "POST" && url.pathname === "/api/operations/cash") {
        const input = await body(request);
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(input.occurredOn ?? ""))
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
        if (input.priorities !== undefined) {
          let priorities: Record<string, number>;
          try {
            priorities = normalizeManualPriorityAssignments(input.priorities);
          } catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
          }
          return json(await dispatcher.submit({
            kind: "priority.plan.manual-create",
            priorities,
            operator: config.webAuth.username,
          }), 202);
        }
        const limit = Number(input.recentCallLimit ?? config.monitor.recentCallLimit);
        if (!config.monitor.recentCallOptions.includes(limit)) return json({ ok: false, error: "评分样本档位无效" }, 400);
        return json(await dispatcher.submit({
          kind: "priority.plan.create",
          recentCallLimit: limit,
          operator: config.webAuth.username,
        }), 202);
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
        return json(await dispatcher.submit({ kind: "priority.plan.confirm", planId: id, operator: config.webAuth.username }), 202);
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
      if (request.method === "GET" && url.pathname === "/api/admin/errors/diagnose") {
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
        return json(await operations.errorDiagnose(
          limit,
          top,
          url.searchParams.get("account"),
          url.searchParams.get("group"),
          url.searchParams.has("failoverRequestIds")
            ? (url.searchParams.get("failoverRequestIds") ?? "")
              .split(",").filter((value) => /^[0-9a-f-]{36}$/iu.test(value))
            : null,
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
          const input = await body(request);
          const profile = input.profile ?? "codex";
          if (profile !== "codex" && profile !== "grok") throw new Error("profile must be codex or grok");
          return json(await operations.oauthPoolEconomics(1, 10, 1, profile));
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
      if (request.method === "POST" && url.pathname === "/api/admin/profit/daily") {
        if (!apiKey) return json({ ok: false, error: "unauthorized" }, 401);
        const input = await body(request);
        if (typeof input.day !== "string") return json({ ok: false, error: "day is required" }, 400);
        try {
          parseCompletedProfitDay(input.day, config.monitor.timezone);
          return json(await operations.dailyProfit(input.day));
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
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
      return errorResponse(error, request);
    }
  };
  return async (request) => {
    if (!cacheable(request)) return await handle(request);
    const authorized = sessionAuthorized(request, config, auth)
      || apiKeyAuthorized(request, auth)
      || request.headers.get("authorization") === `Bearer ${legacyAdminToken}`;
    if (!authorized) return await handle(request);
    const key = cacheKey(request);
    const cached = await operations.getApiCache(key);
    if (cached) {
      if (!cacheRefreshes.has(key)) {
        cacheRefreshes.add(key);
        void handle(request).then(async (response) => {
          if (response.ok) await response.clone().text().then(async (body) => {
            const headers: Record<string, string> = {};
            response.headers.forEach((value, name) => { if (name !== "cache-control" && name !== "content-length") headers[name] = value; });
            await operations.setApiCache(key, response.status, headers, body);
          });
        }).catch(() => undefined).finally(() => cacheRefreshes.delete(key));
      }
      const headers = typeof cached.headers === "string" ? JSON.parse(cached.headers) : cached.headers;
      return new Response(String(cached.body), {
        status: Number(cached.status),
        headers: { ...(headers as Record<string, string>), "cache-control": "no-store", "x-api2business-cache": "hit", "x-api2business-cached-at": String(cached.cached_at) },
      });
    }
    const response = await handle(request);
    if (response.ok) {
      const body = await response.clone().text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => { if (name !== "cache-control" && name !== "content-length") headers[name] = value; });
      void operations.setApiCache(key, response.status, headers, body).catch(() => undefined);
    }
    return response;
  };
}
