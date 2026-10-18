import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

async function renderer(page = 1) {
  const source = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const nodes = new Map<string, { textContent: string; innerHTML: string; disabled: boolean }>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: "", innerHTML: "", disabled: false });
    return nodes.get(selector)!;
  };
  const context: any = {
    $: node, URL, URLSearchParams,
    location: { search: `?page=${page}`, href: `https://api2business.test/ranking?page=${page}` },
    history: { replaceState: () => {} },
    number: String, compact: String, usd: String, cny: String, time: String, escapeHtml: String,
  };
  const ranking = source.slice(source.indexOf("const rankingRefreshIntervals"), source.indexOf("let quotaMonitorRows"));
  const pager = source.slice(source.indexOf("export function renderPager"), source.indexOf("\nfunction signed"));
  runInNewContext(`${ranking}\n${pager.replace('export function', 'function')}\nthis.view = { renderRanking, changeRankingPage };`, context);
  return { node, ...context.view };
}

function snapshot(count: number, date = "2026-10-18") {
  return { ranking: {
    activeUsers: count, pageSize: 20, startDate: date, endDate: date,
    totals: { actualCost: 42, balanceUsd: 100, rechargeCny: 10, requests: 100, tokens: 500 },
    rows: Array.from({ length: count }, (_, index) => ({ rank: index + 1, displayName: `user-${index + 1}@test.com` })),
  } };
}

test("ranking shows active count and pages past 20 without changing totals or resetting ranks", async () => {
  const view = await renderer();
  view.renderRanking(snapshot(41));
  expect(view.node('#ranking-active-users').textContent).toBe('41');
  expect(view.node('#ranking-prev').disabled).toBeTrue();
  expect(view.node('#ranking-body').innerHTML).not.toContain('user-21@test.com');
  view.changeRankingPage(1);
  expect(view.node('#ranking-page').textContent).toBe('2 / 3 · 41 条');
  expect(view.node('#ranking-body').innerHTML).toContain('>21</td>');
  expect(view.node('#ranking-body').innerHTML).toContain('user-21@test.com');
  expect(view.node('#ranking-body').innerHTML).not.toContain('user-41@test.com');
  expect(view.node('#ranking-cost').innerHTML).toBe('42');
  view.changeRankingPage(1);
  expect(view.node('#ranking-body').innerHTML.match(/<tr>/g)).toHaveLength(1);
  expect(view.node('#ranking-next').disabled).toBeTrue();
  view.changeRankingPage(-1);
  expect(view.node('#ranking-page').textContent).toBe('2 / 3 · 41 条');
});

test("refresh preserves a valid page, clamps shrinking results and resets on date rollover", async () => {
  const view = await renderer(2);
  view.renderRanking(snapshot(21));
  view.renderRanking(snapshot(40));
  expect(view.node('#ranking-page').textContent).toBe('2 / 2 · 40 条');
  view.renderRanking(snapshot(0));
  expect(view.node('#ranking-page').textContent).toBe('1 / 1 · 0 条');
  expect(view.node('#ranking-body').innerHTML).toContain('当前窗口暂无用量');
  expect(view.node('#ranking-prev').disabled).toBeTrue();
  expect(view.node('#ranking-next').disabled).toBeTrue();
  view.renderRanking(snapshot(40));
  view.changeRankingPage(1);
  view.renderRanking(snapshot(40, '2026-10-19'));
  expect(view.node('#ranking-page').textContent).toBe('1 / 2 · 40 条');
});
