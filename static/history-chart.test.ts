import { expect, test } from "bun:test";
import { historyChartMarkup } from "./history-chart.js";

test("automatic balance axis keeps distinct negative points above the plot floor", () => {
  const points = [-1, -2].map((balance, index) => ({ sampledAt: `2026-08-02T0${index}:00:00Z`, balance }));
  const options = { series: [{ key: "balance", label: "余额", className: "balance" }], valueFormatter: String };
  const markup = historyChartMarkup(points, options);
  const line = markup.match(/<polyline[^>]*points="([^"]+)"/)![1]!;
  const y = line.split(" ").map(point => Number(point.split(",")[1]));
  expect(y[1]!).toBeGreaterThan(y[0]!);
  expect(y[0]!).toBeGreaterThanOrEqual(24);
  expect(y[1]!).toBeLessThan(164);
  expect(markup).toContain("余额：-2");
  // An explicit lower bound still reports clipping for nonnegative metrics.
  expect(historyChartMarkup(points, { ...options, yMin: 0 })).toContain("低于图表下限 0");
});
