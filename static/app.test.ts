import { expect, test } from "bun:test";

test("account import supports Team manual selection and three price-inferred types", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./account-import.html", import.meta.url)).text();
  const cli = await Bun.file(new URL("../scripts/src/cli.ts", import.meta.url)).text();
  expect(html).toContain('id="import-plan-type"');
  expect(html).toContain('id="import-total-cost"');
  expect(html).toContain('id="import-per-account-proxy"');
  expect(app).toContain("planType: planType.value");
  expect(app).toContain("perAccountProxy: $('#import-per-account-proxy').checked");
  expect(app).toContain("defaults.perAccountProxy === true");
  expect(app).toContain("planType.value = defaults.planType");
  expect(app).toContain("cost < defaults.freeCostThresholdCny ? 'free'");
  expect(app).toContain("cost > defaults.plusCostThresholdCny ? 'plus' : 'k12'");
  expect(app).toContain("planTypeManuallySelected");
  expect(app).toContain("自动识别");
  expect(app).toContain("手动选择");
  expect(app).toContain("platform: platformSelect.value === 'auto' ? undefined : platformSelect.value");
  expect(app).toContain("Number(input.value) === 6");
  expect(html).toContain('id="import-platform-state"');
  expect(app).not.toContain("? 'team'");
  expect(app).toContain("Math.round((total / count) * 100) / 100");
  expect(app).toContain("Array.isArray(payload?.accounts) ? payload.accounts.length : 0");
  expect(cli).toContain("parsed.planType ?? inferredPlanType");
  expect(cli).toContain("k12|plus|team|free");
  expect(cli).not.toContain('inferredPlanType = "team"');
  expect(app).not.toContain("history.replaceState(null, '', `/account-import?job=");
  expect(app).not.toContain("new URLSearchParams(location.search).get('job')");
});

test("upstream management exposes queued quota and usage queries", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./upstreams.html", import.meta.url)).text();
  expect(html).toContain('id="upstream-usage-refresh"');
  expect(html).toContain('id="upstream-edit-usage"');
  expect(app).toContain("requestJson('/api/upstreams/usage'");
  expect(app).toContain("result.databaseQueries");
  expect(html).toContain('class="query-spinner"');
  expect(app).toContain("button.classList.add('is-loading')");
  expect(app).not.toContain("apiKey: activeUpstream");
});

test("score refresh controls expose stable loading animation state", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./scores.html", import.meta.url)).text();
  const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
  expect(html).toContain('id="query-scores" class="query-command"');
  expect(html).toContain('class="query-spinner"');
  expect(app).toContain("$('#score-state').dataset.state = 'refreshing'");
  expect(app).toContain("iconButton.classList.add('is-loading')");
  expect(css).toContain('.state-badge[data-state="refreshing"]::before');
  expect(css).toContain('.icon-command.is-loading');
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

test("score table aligns failures with the displayed rate before failover and recovery", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./scores.html", import.meta.url)).text();

  expect(html).toContain("<th>失败 / 切号 / 恢复</th>");
  expect(app).toContain("${number(row.failureRequests)} / ${number(row.failoverRequests)} / ${number(row.failoverRecovered)}");
  expect(app).toContain("未触发 ${number(row.failoverNotTriggered)}");
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

test("shared navigation remains stable and horizontally scrollable", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
  const http = await Bun.file(new URL("../src/http.ts", import.meta.url)).text();

  expect(app).toContain('class="primary-nav" aria-label="主导航"');
  expect(app).toContain("primaryNav.scrollWidth > primaryNav.clientWidth");
  expect(app).toContain("activeLink.scrollIntoView({ block: 'nearest', inline: 'center' })");
  expect(css).toContain("grid-template-columns: 260px minmax(0, 1fr) max-content");
  expect(css).toContain("flex-wrap: nowrap");
  expect(css).toContain("overflow-x: auto");
  expect(css).toContain("-webkit-overflow-scrolling: touch");
  expect(http).toContain('\"cache-control\": \"no-cache\"');
  expect(http).not.toContain('public, max-age=300');
});

test("operations tables request fixed server-side pages of ten records", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./operations.html", import.meta.url)).text();
  const oauthHtml = await Bun.file(new URL("./oauth-cost.html", import.meta.url)).text();
  const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
  const http = await Bun.file(new URL("../src/http.ts", import.meta.url)).text();

  expect(http).toContain("operations.ledger(period, pageNumber(url), 10)");
  expect(http).toContain("operations.oauthPoolEconomics(pageNumber(url), 10, archivedPage, profile)");
  expect(http).toContain("operations.audits(pageNumber(url), 10)");
  expect(http).toContain("operations.procurement(budget, config.webAuth.username, page, 10)");
  expect(app).toContain("/api/operations/ledger?page=${cashPage}");
  expect(app).toContain("/api/operations/audits?page=${auditPage}");
  expect(app).toContain("/api/operations/oauth-cost?profile=${oauthProfile}&page=${oauthPage}");
  expect(app).toContain("JSON.stringify({ budgetCny: procurementBudget, page: procurementPage })");
  expect(app).not.toContain("procurementAllocations");
  for (const prefix of ["cash", "procurement", "audit"]) {
    expect(html).toContain(`id="${prefix}-prev"`);
    expect(html).toContain(`id="${prefix}-page"`);
    expect(html).toContain(`id="${prefix}-next"`);
  }
  expect(html).not.toContain('id="oauth-cost-form"');
  expect(html).not.toContain('id="oauth-cost-body"');
  expect(html).not.toContain('id="oauth-archived-body"');
  for (const prefix of ["oauth", "oauth-archived"]) {
    expect(oauthHtml).toContain(`id="${prefix}-prev"`);
    expect(oauthHtml).toContain(`id="${prefix}-page"`);
    expect(oauthHtml).toContain(`id="${prefix}-next"`);
  }
  expect(oauthHtml).toContain("当前号池实时成本");
  expect(oauthHtml).toContain('data-oauth-profile="codex"');
  expect(oauthHtml).toContain('data-oauth-profile="grok"');
  expect(app).toContain("profile=${oauthProfile}");
  expect(app).toContain("current-api-output-per-used-free-account");
  expect(oauthHtml).toContain("已归档 OAuth 成本");
  expect(oauthHtml).toContain("<th>平均单价</th>");
  expect(oauthHtml.match(/<th>当前产出 \/ 实时预期 \/ 初始预期<\/th>/g)?.length).toBe(2);
  expect(oauthHtml).toContain("<small>预期成本</small>");
  expect(oauthHtml).toContain("<span>已消耗的实时成本</span>");
  expect(oauthHtml.match(/<th>成本计算<\/th>/g)?.length).toBe(2);
  expect(oauthHtml).not.toContain("<th>人民币 / 刀</th>");
  expect(oauthHtml).not.toContain("<th>预期人民币 / 刀</th>");
  expect(oauthHtml).not.toContain("<th>API 美元产出</th>");
  expect(oauthHtml).not.toContain("<th>理想 API 产出</th>");
  expect(app).toContain("oauthArchivedPage");
  expect(app).toContain("row.averageUnitCostCny");
  expect(app).toContain("idealCnyPerApiUsd");
  expect(app).toContain("remainingIdealApiAmountUsd");
  expect(app).toContain("expectedApiAmountUsd");
  expect(app).toContain("expectedCnyPerApiUsd");
  expect(app).toContain("configuredExpectedCnyPerApiUsd");
  expect(app).toContain("实时成本 / 实时预期成本 / 初始预期成本");
  expect(app).toContain("限流/错误按当前产出");
  expect(app).toContain("当前产出 / 实时预期 / 初始预期（100%）");
  expect(app).not.toContain("全局固定预期");
  expect(oauthHtml).toContain("oauth-cost-ideal-remaining");
  expect(oauthHtml).toContain('id="oauth-cost-refresh-interval"');
  expect(oauthHtml).toContain('<option value="30" selected>30 秒</option>');
  expect(oauthHtml).toContain('<option value="0">关闭</option>');
  expect(oauthHtml).toContain('id="oauth-cost-refresh-countdown"');
  expect(oauthHtml).toContain('class="oauth-cost-combined"');
  expect(css).toContain(".oauth-cost-combined-grid .oauth-cost-ideal { padding-left: 0; border-left: 0; box-shadow: none; }");
  expect(css).toContain("white-space: normal; overflow-wrap: anywhere;");
  expect(oauthHtml).toContain('id="oauth-cost-health-chart"');
  expect(oauthHtml.indexOf('class="oauth-cost-health-metric"')).toBeLessThan(oauthHtml.indexOf('class="oauth-cost-output-metric"'));
  expect(oauthHtml).toContain('class="query-spinner"');
  expect(app).toContain("oauth-output-progress");
  expect(app).toContain("oauth-cost-output-progress");
  expect(app).toContain("oauth-cost-output-progress-label");
  expect(app).toContain("ratio > 1 ? 'is-over' : ''");
  expect(app).toContain("scheduleOauthCostRefresh");
  expect(app).toContain("readOauthRefreshInterval");
  expect(app).toContain("button.classList.add('is-loading')");
  expect(app).toContain("oauth-cost-output-progress-label");
  expect(app).not.toContain("renderRow(total");
});

test("OAuth cost table separates live status buckets and does not infer archived status", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./oauth-cost.html", import.meta.url)).text();

  expect(html).toContain("<th>状态分布</th>");
  expect(app).toContain("statusDistributionCell(row)");
  expect(app).toContain("oauth-status-donut");
  expect(app).toContain("statusDonutMarkup");
  expect(app).not.toContain("isTotal ? health : row");
  expect(app).not.toContain("averageUnitCostCny == null && isTotal");
  expect(app).not.toContain("oauth-total-row");
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

test("score page refreshes once on open and keeps periodic refresh disabled by default", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./scores.html", import.meta.url)).text();

  expect(html).toContain('<option value="0" selected>关闭</option>');
  expect(html).toContain('id="score-refresh-countdown"');
  expect(app).toContain("void refreshPriorityState().catch(() => undefined).finally(scheduleScoreRefresh)");
  expect(app).toContain("const scoreRefreshIntervals = new Set([0, 300, 900, 1800])");
  expect(app).toContain("if (scoreRefreshInFlight !== null) return await scoreRefreshInFlight");
  expect(app).toContain("scheduleScoreRefresh()");
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
  expect(html).toContain('/app.js?v=loading-feedback-v2');
  expect(html).toContain('/styles.css?v=loading-feedback-v2');
});

test("upstream create and update expose timestamped workflow logs", async () => {
  const app = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const html = await Bun.file(new URL("./upstreams.html", import.meta.url)).text();

  expect(html).toContain('id="upstream-create-logs"');
  expect(html).toContain('id="upstream-edit-logs"');
  expect(html).toContain('id="upstream-create-job"');
  expect(html).toContain('id="upstream-edit-job"');
  expect(app).toContain("const appendJobLog = (scope, stage, message");
  expect(app).toContain("if (state !== previousState)");
  expect(app).toContain("jobStatusLogger('create')");
  expect(app).toContain("jobStatusLogger('edit')");
  expect(app).toContain("API key 不会写入日志");
});
