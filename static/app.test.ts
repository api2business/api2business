import { expect, test } from "bun:test";

test("account import exposes K12, Plus, and Free with configured price thresholds", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./account-import.html", import.meta.url)).text();
  expect(html).toContain('id="import-plan-type"');
  expect(html).toContain('id="import-per-account-proxy"');
  expect(app).toContain("cost < defaults.freeCostThresholdCny ? 'free'");
  expect(app).toContain("cost > defaults.plusCostThresholdCny ? 'plus' : 'k12'");
  expect(app).toContain("Number.isFinite(cost) && cost > 0");
  expect(app).toContain("planTypeManuallySelected");
  expect(app).toContain("planType: planType.value");
  expect(app).toContain("perAccountProxy: $('#import-per-account-proxy').checked");
  expect(app).toContain("defaults.perAccountProxy === true");
  expect(app).toContain("planType.value = defaults.planType");
  expect(app).not.toContain("history.replaceState(null, '', `/account-import?job=");
  expect(app).not.toContain("new URLSearchParams(location.search).get('job')");
});

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

test("operations tables request fixed server-side pages of ten records", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./operations.html", import.meta.url)).text();
  const http = await Bun.file(new URL("../src/http.ts", import.meta.url)).text();

  expect(http).toContain("operations.ledger(period, pageNumber(url), 10)");
  expect(http).toContain("operations.oauthPoolEconomics()");
  expect(http).toContain("operations.audits(pageNumber(url), 10)");
  expect(http).toContain("operations.procurement(budget, config.webAuth.username, page, 10)");
  expect(app).toContain("/api/operations/ledger?page=${cashPage}");
  expect(app).toContain("/api/operations/audits?page=${auditPage}");
  expect(app).toContain("/api/operations/oauth-cost?page=${oauthPage}");
  expect(app).toContain("JSON.stringify({ budgetCny: procurementBudget, page: procurementPage })");
  expect(app).not.toContain("procurementAllocations");
  for (const prefix of ["oauth", "oauth-archived", "cash", "procurement", "audit"]) {
    expect(html).toContain(`id="${prefix}-prev"`);
    expect(html).toContain(`id="${prefix}-page"`);
    expect(html).toContain(`id="${prefix}-next"`);
  }
  expect(html).toContain("OAuth 当前池实时成本");
  expect(html).toContain("已归档 OAuth 成本");
  expect(html).toContain("<th>平均单价</th>");
  expect(html).toContain("<th>API 产出 / 理想产出</th>");
  expect(html).toContain("<small>预期成本</small>");
  expect(html).toContain("<th>预期人民币 / 刀</th>");
  expect(html).not.toContain("<th>API 美元产出</th>");
  expect(html).not.toContain("<th>理想 API 产出</th>");
  expect(app).toContain("oauthArchivedPage");
  expect(app).toContain("row.averageUnitCostCny");
  expect(app).toContain("idealCnyPerApiUsd");
  expect(app).toContain("remainingIdealApiAmountUsd");
  expect(html).toContain("oauth-cost-ideal-remaining");
  expect(html).toContain('id="oauth-cost-refresh-interval"');
  expect(html).toContain('<option value="30" selected>30 秒</option>');
  expect(html).toContain('<option value="0">关闭</option>');
  expect(html).toContain('id="oauth-cost-refresh-countdown"');
  expect(html).toContain('class="oauth-cost-combined"');
  expect(html).toContain('id="oauth-cost-health-chart"');
  expect(html.indexOf('class="oauth-cost-health-metric"')).toBeLessThan(html.indexOf('class="oauth-cost-output-metric"'));
  expect(html).toContain('class="query-spinner"');
  expect(app).toContain("oauth-output-progress");
  expect(app).toContain("oauth-cost-output-progress");
  expect(app).toContain("oauth-cost-output-progress-label");
  expect(app).toContain("ratio > 1 ? 'is-over' : ''");
  expect(app).toContain("scheduleOauthCostRefresh");
  expect(app).toContain("readOauthRefreshInterval");
  expect(app).toContain("button.classList.add('is-loading')");
  expect(app).toContain("oauth-cost-output-progress-label");
  expect(app).toContain("renderRow(total");
});

test("OAuth cost table separates live status buckets and does not infer archived status", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./operations.html", import.meta.url)).text();

  expect(html).toContain("<th>状态分布</th>");
  expect(app).toContain("statusDistributionCell(row,");
  expect(app).toContain("oauth-status-donut");
  expect(app).toContain("statusDonutMarkup");
  expect(app).toContain("isTotal ? health : row");
  expect(app).toContain("averageUnitCostCny == null && isTotal");
  expect(app).toContain("aria-label=\"账号状态分布\"");
  expect(app).toContain("row.scope === 'archived'");
  expect(app).toContain("oauth-status-unavailable");
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

test("score table renders a bounded ten-row page with local navigation", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./scores.html", import.meta.url)).text();

  expect(app).toContain("const scorePageSize = 10");
  expect(app).toContain("filteredRows.slice(start, start + scorePageSize)");
  expect(app).toContain("$('#score-prev').addEventListener('click'");
  expect(app).toContain("$('#score-next').addEventListener('click'");
  expect(app).toContain("scorePage = 1");
  expect(html).toContain('id="score-prev"');
  expect(html).toContain('id="score-page"');
  expect(html).toContain('id="score-next"');
});

test("score toolbar refresh uses the queue-backed manual ranking path", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const start = app.indexOf("$('#refresh-scores').addEventListener");
  const end = app.indexOf("const initial = await requestJson('/api/scores')", start);
  const handler = app.slice(start, end);

  expect(handler).toContain("await refreshPriorityState()");
  expect(handler).not.toContain("/api/scores/refresh");
});

test("zero-change priority history is labelled as converged", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();

  expect(app).toContain("Number(row.changed_count) === 0");
  expect(app).toContain("已收敛");
});

test("priority history renders one combined pool label with per-pool counts", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./scores.html", import.meta.url)).text();

  expect(app).toContain("profiles.map(label).join(' + ')");
  expect(app).toContain("row.profile_changed_counts ?? {}");
  expect(app).toContain("`${label(profile)} ${number(counts[profile] ?? 0)}`");
  expect(html).toContain("/app.js?v=availability-reasons-v1");
  expect(html).toContain("/styles.css?v=availability-reasons-v1");
});
