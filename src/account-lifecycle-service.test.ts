import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountLifecycleService, accountLifecycleCandidateQuery, readLifecycleAcquisitionCosts } from "./account-lifecycle-service";
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

test("includes YAML acquisition entries so manually recorded OAuth accounts enter lifecycle detection", () => {
  const root = mkdtempSync(join(tmpdir(), "apistate-lifecycle-yaml-"));
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
