import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { balanceNumber } from "./balance-format.js";
import { historyChartMarkup } from "./history-chart.js";
import { buildSupplierQualityAssets } from "./upstream-quality-assets.js";
import { sampleTimeDisplay } from "./sample-time.js";
import { sortTableRows } from "./table-sort.js";

async function renderer() {
  const source = await Bun.file(new URL("./upstream-scheduling-v2.js", import.meta.url)).text();
  const nodes = new Map<string, { textContent: string; innerHTML: string; disabled: boolean }>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: "", innerHTML: "", disabled: false });
    return nodes.get(selector)!;
  };
  const context: any = {
    document: { querySelector: node }, balanceNumber, buildSupplierQualityAssets,
    historyChartMarkup, sampleTimeDisplay, sortTableRows,
    renderDonut: () => {}, bindHistoryChartTooltip: () => {}, updateTableSortHeaders: () => {},
  };
  runInNewContext(source.replace(/^import .*$/gm, "").replace("export async function", "async function")
    + "\nthis.render = { state, renderQuota, renderAccounts, accountSortValue };", context);
  return { node, ...context.render };
}

test("V2 renders converted CNY balances while output and hourly usage remain USD", async () => {
  const view = await renderer();
  // A non-unit valuation makes a relabelled dollar value distinguishable from CNY.
  view.renderQuota({
    totalRemainingCny: 70, schedulableRemainingCny: 35, consumedCny: 14, apiAmountUsd: 123.456,
    realtimeCostCnyPerApiUsd: 0.2, sampleRealtimeCostCnyPerApiUsd: 0.3,
    history: ["2026-10-16T00:00:00Z", "2026-10-16T00:10:00Z"].map(sampledAt => ({
      sampledAt, sampleApiAmountUsdPerHour: 12.5, rollingApiAmountUsdPerHour: 25,
      sampleRealtimeCostCnyPerApiUsd: 0.3, realtimeCostCnyPerApiUsd: 0.2 })),
  });
  expect(view.node("#v2-quota-total").textContent).toBe("¥70.00");
  expect(view.node("#v2-quota-consumed").textContent).toBe("¥14.00");
  expect(view.node("#v2-quota-output").textContent).toBe("$123.456");
  expect(view.node("#v2-quota-sample-speed").textContent).toBe("$12.500");
  expect(view.node("#v2-quota-rolling-speed").textContent).toBe("$25.000");
  expect(view.node("#v2-quota-realtime-cost").textContent).toBe("¥0.2000/API 美元");
  const speedChart = view.node("#v2-quota-balance-chart").innerHTML;
  expect(speedChart).toContain("API 美元 / 小时");
  expect(speedChart).toContain("$12.500");
  expect(speedChart).not.toContain("人民币");
  expect(view.node("#v2-quota-cost-chart").innerHTML).toContain("人民币 / API 美元");
  expect(view.node("#v2-quota-cost-chart").innerHTML).toContain("¥0.3000");

  view.state.accounts = [{ accountId: 1, accountName: "https://wallet.test", quotaCacheStatus: "cached",
    quota: { unit: "USD", remaining: 10 }, accountBalanceCny: 70,
    usage: { apiAmountUsd: 42, costRateCnyPerApiUsd: 0.2 } }];
  view.renderAccounts();
  const cells = view.node("#v2-account-body").innerHTML.split("<td");
  expect(cells[5]).toContain("¥70.00");
  expect(cells[5]).not.toContain("$10.000");
  expect(cells[6]).toContain("¥0.2000/API 美元");
  expect(cells[7]).toContain("$42.000");
});

test("V2 preserves converted CNY debt precision and distinguishes zero from missing money", async () => {
  const view = await renderer();
  view.state.accounts = [-0.000004, 0, null].map((remaining, index) => ({
    accountId: index + 1, quotaCacheStatus: "cached", quota: { unit: "USD", remaining },
    accountBalanceCny: remaining === null ? null : remaining * 7,
    usage: { apiAmountUsd: remaining },
  }));
  view.renderAccounts();
  const rows = view.node("#v2-account-body").innerHTML.split("<tr>").slice(1);
  const cells = rows.map((row: string) => row.split("<td")[5]);
  expect(cells[0]).toContain("¥-0.000028");
  expect(cells[0]).not.toContain("¥-0.00<");
  expect(cells[1]).toContain("¥0.00");
  expect(cells[2]).not.toContain("¥0.00");
  expect(cells[2]).toContain("—");
  view.renderQuota({ totalRemainingCny: -0.000004, consumedCny: 0, apiAmountUsd: null });
  expect(view.node("#v2-quota-total").textContent).toBe("¥-0.000004");
  expect(view.node("#v2-quota-consumed").textContent).toBe("¥0.00");
  expect(view.node("#v2-quota-output").textContent).toBe("暂不可计算");
});

test("V2 sorts by converted balances and keeps missing valuation distinct from raw dollars", async () => {
  const view = await renderer();
  view.state.accountSort = { key: "balance", direction: "desc" };
  view.state.accounts = [
    { accountId: 1, accountName: "higher-raw-usd", quota: { remaining: 100 }, accountBalanceCny: 10 },
    { accountId: 2, accountName: "higher-cny-value", quota: { remaining: 20 }, accountBalanceCny: 40 },
    { accountId: 3, accountName: "missing-valuation", quota: { remaining: 1000 }, accountBalanceCny: null },
  ].map(row => ({ ...row, quotaCacheStatus: "cached" }));
  view.renderAccounts();
  const html = view.node("#v2-account-body").innerHTML;
  expect(html.indexOf("higher-cny-value")).toBeLessThan(html.indexOf("higher-raw-usd"));
  expect(html.indexOf("higher-raw-usd")).toBeLessThan(html.indexOf("missing-valuation"));
  const missingBalance = html.split("<tr>")[3].split("<td")[5];
  expect(missingBalance).toContain("—");
  expect(missingBalance).not.toContain("1,000");
  expect(view.accountSortValue(view.state.accounts[0], "balance")).toBe(10);
});
