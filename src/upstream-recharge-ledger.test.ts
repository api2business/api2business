import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpstreamRechargeCosts, recordUpstreamRechargeCost } from "./upstream-recharge-ledger";

function input(path: string, operationId = "recharge-1") {
  return {
    path,
    operationId,
    occurredOn: "2026-07-31",
    accountId: 77,
    accountName: "https://api.example.com plus 0.045",
    baseUrl: "https://api.example.com",
    suffix: "plus",
    rateCnyPerApiUsd: 0.045,
    amountCny: 20,
  };
}

test("upstream recharge ledger is CNY, owner-only, and idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "apistate-upstream-ledger-"));
  const path = join(directory, "ledger", "upstream.jsonl");
  const first = recordUpstreamRechargeCost(input(path));
  const duplicate = recordUpstreamRechargeCost(input(path));
  expect(first.mutation).toBe(true);
  expect(duplicate.mutation).toBe(false);
  expect(readUpstreamRechargeCosts(path)).toHaveLength(1);
  expect(readFileSync(path, "utf8")).not.toContain("api_key");
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("reusing an upstream recharge idempotency key for another amount is rejected", () => {
  const directory = mkdtempSync(join(tmpdir(), "apistate-upstream-ledger-conflict-"));
  const path = join(directory, "ledger", "upstream.jsonl");
  recordUpstreamRechargeCost(input(path));
  expect(() => recordUpstreamRechargeCost({ ...input(path), amountCny: 50 })).toThrow("幂等键已用于其他账号或金额");
});
