import { expect, test } from "bun:test";
import { AccountLifecycleService, accountLifecycleCandidateQuery } from "./account-lifecycle-service";
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
