import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountLifecycleService, accountLifecycleCandidateQuery, lifecycleRetirementReason, readLifecycleAcquisitionCosts } from "./account-lifecycle-service";
import type { AppConfig } from "./config";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

test("refuses settlement while any OAuth test is inconclusive", () => {
  const service = new AccountLifecycleService({} as AppConfig, {} as Sub2ApiReadClient);
  const job = {
    id: "job-1", state: "succeeded", createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    settings: { day: "2026-07-30", planType: "k12", model: "gpt-5.6-sol", confirm: true },
    fingerprint: "f", logs: [], candidates: [{ accountId: 1 }, { accountId: 2 }],
    result: { summary: { alive: 0, dead: 1, unknown: 1 } }, settlement: null, error: null,
  };
  (service as unknown as { jobs: Map<string, unknown> }).jobs.set(job.id, job);
  expect(() => service.settle(job.id)).toThrow("并非全部确定死亡");
});

test("candidate query projects lifecycle facts without OAuth credentials", () => {
  expect(accountLifecycleCandidateQuery).toContain("account.deleted_at IS NULL");
  expect(accountLifecycleCandidateQuery).not.toContain("access_token");
  expect(accountLifecycleCandidateQuery).not.toContain("refresh_token");
});

test("pool retirement treats free and plus rate limits as dead but retains rate-limited k12", () => {
  expect(lifecycleRetirementReason({ planType: "free", stateBucket: "rate_limited" }, "database-dead")).toBe("database-rate-limited");
  expect(lifecycleRetirementReason({ planType: "plus", stateBucket: "rate_limited" }, "database-dead")).toBe("database-rate-limited");
  expect(lifecycleRetirementReason({ planType: "k12", stateBucket: "rate_limited" }, "database-dead")).toBeNull();
  expect(lifecycleRetirementReason({ planType: "k12", stateBucket: "error" }, "database-dead")).toBe("database-error");
  expect(lifecycleRetirementReason({ planType: "plus", stateBucket: "normal" }, "database-dead")).toBeNull();
});

test("settlement keeps its confirmed candidates when a worker snapshot omits them", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const job = {
    id: "job-settlement", state: "settling" as const, createdAt: new Date().toISOString(), completedAt: null,
    settings: { day: "2026-08-01", planType: "all" as const, model: "gpt-5.6-sol", confirm: false, selectionMode: "database-dead" as const, scope: "pool" as const },
    fingerprint: "fingerprint", logs: [], candidates: [], result: null, settlement: null, error: null,
  };
  const service = new AccountLifecycleService({} as AppConfig, {} as Sub2ApiReadClient, null, {
    get: async () => structuredClone(job),
    patch: async (_id, patch) => { patches.push(patch as Record<string, unknown>); },
  });
  await (service as unknown as { runSettlementWorker(id: string, candidateIds: number[]): Promise<unknown> })
    .runSettlementWorker("job-settlement", [17, 19]);
  expect(patches.some((patch) => Object.hasOwn(patch, "candidates"))).toBeFalse();
});

test("includes YAML acquisition entries so manually recorded OAuth accounts enter lifecycle detection", () => {
  const root = mkdtempSync(join(tmpdir(), "api2business-lifecycle-yaml-"));
  const ledger = join(root, "pool.yaml");
  writeFileSync(ledger, [
    "profit:",
    "  periodCosts:",
    "    - kind: acquisition",
    "      occurredOn: 2026-07-30",
    "      accountId: 104",
    "      amountCny: 3.3",
    "    - kind: recharge",
    "      occurredOn: 2026-07-30",
    "      accountId: 29",
    "      amountCny: 50",
  ].join("\n"));
  const config = { operations: { ledgerYamlPath: ledger } } as AppConfig;
  expect(readLifecycleAcquisitionCosts(config, "2026-07-30")).toEqual([{ accountId: 104, costCny: 3.3 }]);
});
