import { expect, test } from "bun:test";

test("实时成本图表按数据范围显示，不使用 0.3 上限", async () => {
  const v2 = await Bun.file(new URL("./upstream-scheduling-v2.js", import.meta.url)).text();
  const upstreams = await Bun.file(new URL("./ledger-pages.js", import.meta.url)).text();
  expect(v2).not.toContain("yMax: 0.3");
  expect(upstreams).not.toContain("yMax: 0.3");
});
