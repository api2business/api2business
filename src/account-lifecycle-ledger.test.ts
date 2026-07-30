import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { recordLifecycleSettlement } from "./account-lifecycle-ledger";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("records one idempotent OAuth lifecycle settlement without credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "apistate-lifecycle-ledger-"));
  roots.push(root);
  const path = join(root, "ledger.jsonl");
  const input = {
    acquisitionDay: "2026-07-30" as const, planType: "k12" as const, accountIds: [101, 102], accountCount: 2,
    grossAcquisitionCostCny: 7, requestCount: 20, tokenCount: 3000, apiAmountUsd: 10,
    grossCnyPerApiUsd: 0.7, detectionJobId: "job-1", detectionFingerprint: "fingerprint-1",
  };
  expect(recordLifecycleSettlement(path, input).mutation).toBe(true);
  expect(recordLifecycleSettlement(path, { ...input, detectionJobId: "job-2" }).mutation).toBe(false);
  const content = readFileSync(path, "utf8");
  expect(content.trim().split("\n")).toHaveLength(1);
  expect(content).not.toContain("credentials");
  expect(content).not.toContain("access_token");
  expect(content).not.toContain("refresh_token");
});
