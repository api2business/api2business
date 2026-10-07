import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

async function requestHarness(response: Response) {
  const source = await Bun.file(new URL("./upstream-scheduling-v2.js", import.meta.url)).text();
  const redirects: string[] = [];
  const timers = new Set<number>();
  const requests: { path: string; options: RequestInit }[] = [];
  const context: any = {
    AbortController,
    location: { replace: (path: string) => redirects.push(path) },
    setTimeout: () => { timers.add(1); return 1; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (path: string, options: RequestInit) => {
      requests.push({ path, options });
      return response;
    },
  };
  runInNewContext(source.replace(/^import .*$/gm, "").replace("export async function", "async function")
    + "\nthis.requestJson = requestJson;", context);
  return { requestJson: context.requestJson, redirects, timers, requests };
}

test("V2 redirects expired sessions on initial, refresh and probe-history reads before parsing the body", async () => {
  for (const path of ["/api/v2/upstream-scheduling/scopes", "/api/v2/upstream-scheduling/snapshot?scope=codex", "/api/v2/upstream-scheduling/probe-history?scope=grok&page=2"]) {
    const response = new Response("unauthorized", { status: 401 });
    response.json = () => { throw new Error("body must not be read before redirect"); };
    const harness = await requestHarness(response);
    await expect(harness.requestJson(path, { refresh: true })).rejects.toThrow("登录状态已失效");
    expect(harness.redirects).toEqual(["/login"]);
    expect(harness.timers.size).toBe(0);
  }
});

test("V2 keeps successful reads and ordinary failures on the current page", async () => {
  const success = await requestHarness(Response.json({ ok: true, scope: "claude" }));
  expect(await success.requestJson("/api/v2/upstream-scheduling/snapshot?scope=claude", { refresh: true })).toEqual({ ok: true, scope: "claude" });
  expect(success.requests[0]!.options).toMatchObject({ cache: "no-store", headers: { "x-api2business-refresh": "1" } });
  expect(success.redirects).toEqual([]);
  expect(success.timers.size).toBe(0);
  for (const status of [403, 500]) {
    const failure = await requestHarness(Response.json({ ok: false, error: "读取失败" }, { status }));
    await expect(failure.requestJson("/api/v2/upstream-scheduling/snapshot?scope=codex")).rejects.toThrow("读取失败");
    expect(failure.redirects).toEqual([]);
    expect(failure.timers.size).toBe(0);
  }
});

test("upstream scheduling V2 is a Codex-first read-only page", async () => {
  const html = await Bun.file(new URL("./upstream-scheduling-v2.html", import.meta.url)).text();
  const script = await Bun.file(new URL("./upstream-scheduling-v2.js", import.meta.url)).text();
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  expect(html).toContain("上游调度 V2");
  expect(html).toContain('data-page="upstream-scheduling-v2"');
  expect(html).toContain('id="v2-scope-switch"');
  expect(html).toContain('class="pool-quality-head"');
  expect(html).toContain('unified-quota-monitor');
  expect(html).toContain('class="pool-quality-band"');
  expect(html).toContain("unified-upstream-table");
  expect(html).toContain('id="v2-error-body"');
  expect(html).toContain('id="v2-history-body"');
  expect(html).toContain('id="v2-probe-body"');
  expect(html).toContain('id="v2-account-table"');
  expect(html).toContain('data-sort-key="score"');
  expect(html).toContain('data-sort-key="priority"');
  expect(html).not.toContain('id="v2-plan-table"');
  expect(html).not.toContain('只读优先级计划');
  expect(html).toContain('id="v2-automation-state"');
  expect(html).toContain('id="v2-refresh-interval"');
  expect(html).toContain('<option value="30" selected>30 秒</option>');
  expect(html).toContain('id="v2-refresh-countdown"');
  expect(html).not.toContain("对账");
  expect(script).not.toContain("对账");
  expect(script).toContain("/api/v2/upstream-scheduling/scopes");
  expect(script).toContain("/api/v2/upstream-scheduling/snapshot");
  expect(script).not.toContain("/api/v2/upstream-scheduling/plan");
  expect(script).toContain("scopeRequestId");
  expect(script).toContain("x-api2business-refresh");
  expect(script).toContain("api2business.operations.upstream-scheduling-v2-refresh-interval.v1");
  expect(script).toContain("scheduleAutoRefresh");
  expect(script).toContain("loadScope(true)");
  expect(script).toContain("保留上一份快照");
  expect(script).toContain("state.activeScope !== scope");
  expect(script).toContain("new URLSearchParams(location.search)");
  expect(script).toContain("updateScopeDeepLink(state.activeScope, 'push')");
  expect(script).toContain("window.addEventListener('popstate'");
  expect(script).toContain("额度缓存");
  expect(script).toContain("不限额");
  expect(script).toContain("sampleTimeDisplay");
  expect(script).toContain("次采样");
  expect(script).not.toContain("yMax: 0.3");
  expect(script).toContain("bindTableSortHeaders");
  expect(script).toContain("sortTableRows");
  expect(script).toContain('target="_blank"');
  expect(script).toContain('rel="noopener noreferrer"');
  expect(script).toContain("function externalUpstreamUrl(row)");
  expect(script).not.toMatch(/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/u);
  expect(app).toContain("upstream-scheduling-v2");
});


test("V2 defaults to 30 seconds and continues after a failed refresh", async () => {
  const source = await Bun.file(new URL("./upstream-scheduling-v2.js", import.meta.url)).text();
  const nodes = new Map<string, any>([
    ["#v2-refresh-interval", { value: "30" }],
    ["#v2-refresh-countdown", { textContent: "" }],
    ["#v2-refresh", { disabled: false }],
    ["#v2-data-state", { textContent: "", dataset: {} }],
    ["#v2-data-detail", { textContent: "" }],
  ]);
  const timers = new Map<number, { callback: () => Promise<void>; ms: number }>();
  let timerId = 0;
  let stored: string | null = null;
  let headers: unknown;
  const context: any = {
    document: { querySelector: (selector: string) => nodes.get(selector) },
    localStorage: { getItem: () => stored },
    setTimeout: (callback: () => Promise<void>, ms: number) => {
      timers.set(++timerId, { callback, ms }); return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: () => ++timerId,
    clearInterval: () => {},
    AbortController,
    fetch: async (_url: string, options: { headers: unknown }) => {
      headers = options.headers;
      throw new Error("HTTP 502");
    },
  };
  runInNewContext(source.replace(/^import .*$/gm, "").replace("export async function", "async function")
    + "\nthis.controls = { state, readRefreshInterval, scheduleAutoRefresh };", context);
  const { state, readRefreshInterval, scheduleAutoRefresh } = context.controls;
  expect(readRefreshInterval()).toBeNull();
  stored = "0";
  expect(readRefreshInterval()).toBe(0);
  stored = "invalid";
  expect(readRefreshInterval()).toBeNull();
  state.activeScope = "claude";
  const previous = { scope: "claude", data: { accounts: [{ accountId: 42 }] } };
  state.snapshot = previous;
  scheduleAutoRefresh();
  expect([...timers.values()].map((timer) => timer.ms)).toEqual([30000]);
  expect(nodes.get("#v2-refresh-countdown").textContent).toBe("下次刷新 00:30");
  await [...timers.values()][0].callback();
  expect(headers).toEqual({ "x-api2business-refresh": "1" });
  expect(state.snapshot).toBe(previous);
  expect(nodes.get("#v2-data-detail").textContent).toContain("保留上一份快照");
  expect(nodes.get("#v2-refresh").disabled).toBeFalse();
  expect([...timers.values()].map((timer) => timer.ms)).toEqual([30000]);
  nodes.get("#v2-refresh-interval").value = "0";
  scheduleAutoRefresh();
  expect(timers.size).toBe(0);
  expect(nodes.get("#v2-refresh-countdown").textContent).toBe("自动刷新已关闭");
});
