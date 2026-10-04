import { expect, test } from "bun:test";
import { compareTableValues, sortTableRows } from "./table-sort.js";

test("shared table sorter keeps missing values at the end", () => {
  expect(sortTableRows([
    { id: 1, score: null },
    { id: 2, score: 88 },
    { id: 3, score: 92 },
  ], { key: "score", direction: "desc" }, (row, key) => row[key], (a, b) => a.id - b.id).map((row) => row.id)).toEqual([3, 2, 1]);
  expect(sortTableRows([
    { id: 1, score: null },
    { id: 2, score: 88 },
    { id: 3, score: 92 },
  ], { key: "score", direction: "asc" }, (row, key) => row[key], (a, b) => a.id - b.id).map((row) => row.id)).toEqual([2, 3, 1]);
});

test("shared table sorter compares Chinese labels naturally", () => {
  expect(compareTableValues("账号 2", "账号 10")).toBeLessThan(0);
});
