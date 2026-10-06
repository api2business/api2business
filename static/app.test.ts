import { expect, test } from "bun:test";

async function read(name: string) { return await Bun.file(new URL(name, import.meta.url)).text(); }

test("navigation exposes V2 as the only scheduling entry", async () => {
  const app = await read("./app.js");
  const http = await read("../src/http.ts");
  expect(app).toContain("['upstream-scheduling-v2', '/upstream-scheduling-v2', '上游调度 V2']");
  expect(app).not.toContain("'/scores'");
  expect(http).toContain('url.pathname === "/scores"');
  expect(http).toContain('const schedulingHome = "/upstream-scheduling-v2"');
  expect(http).toContain('return redirect(session ? schedulingHome : "/login")');
});

test("quota monitor keeps reading persistent usage cache", async () => {
  const app = await read("./app.js");
  const html = await read("./quota-monitor.html");
  expect(app).toContain("quotaMonitorAccountRead('/api/upstreams/usage-cache', ids)");
  expect(app).toContain("quotaMonitorAccountRead('/api/upstreams/quota-monitor-usage', ids)");
  expect(app).toContain("requestJson('/api/upstreams/quota-summary',");
  expect(app).toContain("/api/upstreams?page=1&pageSize=100");
  expect(app).toContain("Promise.allSettled");
  expect((await read("../src/http.ts"))).toContain("pageSize must be from 1 to 100");
  expect(html).toContain('id="quota-monitor-refresh-interval"');
  expect(html).toContain('id="quota-monitor-range"');
  expect(app).toContain("function upstreamWalletMarkup(row)");
  expect(app).toContain('target="_blank"');
  expect(app).toContain('rel="noopener noreferrer"');
  expect(app).toContain("'claude-kiro'");
  expect(html).toContain('data-quota-filter="claude-kiro"');
  expect(html).toContain("Claude Kiro");
});

test("V2 account table renders quota cache coverage", async () => {
  const source = await read("./upstream-scheduling-v2.js");
  const html = await read("./upstream-scheduling-v2.html");
  expect(source).toContain("quotaCoverage");
  expect(source).toContain("row.quota?.remaining");
  expect(source).toContain("quotaCacheStatus");
  expect(html).toContain('id="v2-scope-switch"');
  expect(html).toContain('id="v2-account-body"');
});

test("V2 displays quota and output values as RMB", async () => {
  const source = await read("./upstream-scheduling-v2.js");
  const html = await read("./upstream-scheduling-v2.html");
  expect(source).toContain("function cny(value)");
  expect(source).toContain("row.quota?.remaining == null ? '—' : cny(row.quota.remaining)");
  expect(source).toContain("cny(row.usage?.apiAmountUsd)");
  expect(source).toContain("unit: '人民币 / 小时'");
  expect(source).not.toContain("usd(");
  expect(html).toContain("人民币 / 小时");
  expect(html).toContain("人民币 / 刀");
  expect(html).not.toContain("API 美元");
});

test("retired scheduling commands are absent from the CLI", async () => {
  const cli = await read("../skills/api2business/scripts/src/cli.ts");
  expect(cli).toContain("upstream-scheduling-v2 scopes|snapshot|plan");
  expect(cli).toContain("priority history --over-api");
  expect(cli).not.toContain("priority " + "automation");
  expect(cli).not.toContain("priority" + "-plan");
  expect(cli).not.toContain("manual-create");
});

test("shared navigation remains horizontally scrollable", async () => {
  const app = await read("./app.js");
  const css = await read("./styles.css");
  expect(app).toContain('class="primary-nav" aria-label="主导航"');
  expect(app).toContain("activeLink.scrollIntoView({ block: 'nearest', inline: 'center' })");
  expect(css).toContain("overflow-x: auto");
});

test("account display names preserve provider suffixes", async () => {
  const source = await read("./app.js");
  const start = source.indexOf("export function displayAccountName(value, baseUrl = '')");
  const end = source.indexOf("\n}\n\nconst poolParticipationColors", start) + 2;
  const displayAccountName = new Function(`${source.slice(start, end).replace("export function", "function")}; return displayAccountName`)();
  expect(displayAccountName("https://hyueapi.com pro 0.2", "https://hyueapi.com")).toBe("https://hyueapi.com pro");
  expect(displayAccountName("https://foo.test Grok-0.24", "https://foo.test")).toBe("https://foo.test Grok-0.24");
});
