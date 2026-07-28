import { expect, test } from "bun:test";

test("automation submit preserves the user's current form values", async () => {
  const source = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const start = source.indexOf("$('#automation-form').addEventListener");
  const end = source.indexOf("$('#generate-plan').addEventListener", start);
  const handler = source.slice(start, end);

  expect(handler).toContain("const input = {");
  expect(handler).toContain("intervalSeconds: Number($('#automation-interval').value)");
  expect(handler).toContain("body: JSON.stringify(input)");
  expect(handler).not.toContain("await loadPriorityAutomation()");
});

test("score and manual priority planning share one sample selector and one table", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./scores.html", import.meta.url)).text();

  expect(html).toContain('id="score-call-limit"');
  expect(html).not.toContain('id="plan-limit"');
  expect(html).not.toContain('id="plan-body"');
  expect(html).toContain("<th>当前优先级</th><th>计划优先级</th><th>变化</th>");
  expect(app).toContain("recentCallLimit: Number($('#score-call-limit').value)");
  expect(app).not.toContain("$('#plan-limit')");
  expect(app).not.toContain("$('#refresh-priority')");
  expect(app).toContain("priorityPlanRows.get(String(row.accountId))");
});

test("score rendering applies the monotonic freshness guard", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const http = await Bun.file(new URL("../src/http.ts", import.meta.url)).text();

  expect(app).toContain("if (!shouldApplyScorePayload(scoreRefreshedAt, data)) return false");
  expect(http).toContain('url.pathname === "/score-display-freshness.js"');
});

test("score table renders failover count before recovered count", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./scores.html", import.meta.url)).text();

  expect(html).toContain("<th>切号 / 恢复</th>");
  expect(app).toContain("${number(row.failoverRequests)} / ${number(row.failoverRecovered)}");
  expect(app).not.toContain("${number(row.failoverRecovered)} / ${number(row.failoverRequests)}");
});

test("manual plan confirmation allows paced batches to finish before the browser timeout", async () => {
  const source = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const start = source.indexOf("$('#confirm-plan').addEventListener");
  const end = source.indexOf("await Promise.all([", start);
  const handler = source.slice(start, end);

  expect(handler).toContain("600000");
});

test("priority adjustment history is paginated instead of growing without bound", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./scores.html", import.meta.url)).text();

  expect(app).toContain("const priorityHistoryPageSize = 10");
  expect(app).toContain("priorityHistoryRecords.slice(start, start + priorityHistoryPageSize)");
  expect(html).toContain('id="history-prev"');
  expect(html).toContain('id="history-page-state"');
  expect(html).toContain('id="history-next"');
});

test("score table separates Codex and Grok accounts with profile tabs", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./scores.html", import.meta.url)).text();

  expect(html).toContain('data-score-profile="codex"');
  expect(html).toContain('data-score-profile="grok"');
  expect(app).toContain("scoreRowsForActiveProfile()");
  expect(app).toContain("String(row.platform ?? '').toLowerCase() === 'grok'");
  expect(app).toContain("candidate.setAttribute('aria-selected', String(selected))");
});

test("zero-change priority history is labelled as converged", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();

  expect(app).toContain("Number(row.changed_count) === 0");
  expect(app).toContain("已收敛");
});
