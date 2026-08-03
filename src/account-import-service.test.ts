import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountImportService, archiveAccountImportContent, importFailure, isTimeoutError, recoveredImportOutput } from "./account-import-service";
import type { AccountImportPreflightPlan } from "./account-import-preflight";
import type { AppConfig } from "./config";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import { runtimeImportIdempotencyKey } from "./sub2api-runtime-service";

test("projects YAML-owned account import defaults", () => {
  const service = new AccountImportService({ operations: {
    accountImportDefaults: {
      priority: 1, capacity: 16, groupIds: [2, 3], sourceProxyId: 3, perAccountProxy: false,
      importTimeoutMs: 120000, planType: "k12", freeCostThresholdCny: 1, plusCostThresholdCny: 7,
    },
    oauthEconomics: { idealApiUsdPerAccount: { free: 3.8, k12: 20, plus: 135, team: 140 } },
  } } as AppConfig, {} as Sub2ApiReadClient);
  expect(service.options().defaults).toEqual({
    priority: 1, capacity: 16, groupIds: [2, 3], sourceProxyId: 3, perAccountProxy: false,
    importTimeoutMs: 120000, unitCostCny: null, planType: "k12", freeCostThresholdCny: 1, plusCostThresholdCny: 7,
  });
  expect(service.options().planTypes).toEqual([{ id: "k12", name: "K12" }, { id: "plus", name: "Plus" }, { id: "team", name: "Team" }, { id: "free", name: "Free" }]);
  expect(service.options().initialExpectedApiUsdPerAccount).toEqual({ free: 3.8, k12: 20, plus: 135, team: 140 });
});

test("projects nested CLI errors without exposing credentials", () => {
  const message = importFailure({ ok: false, error: { code: "runtime_failed", message: "login failed for user@example.com with sk-secret" } });
  expect(message).toBe("runtime_failed: login failed for [REDACTED] with [REDACTED]");
});

test("projects nested runtime errors", () => {
  expect(importFailure({ ok: false, data: { runtime: { error: "source proxy 3 does not exist" } } })).toBe("source proxy 3 does not exist");
});

test("projects partial import failures with indexes and redaction", () => {
  expect(importFailure({ ok: false, result: { failed: 2, failures: [
    { index: 2, reason: "request for user@example.com failed" },
    { index: 8, reason: "refresh rt.1.secret expired" },
  ] } })).toBe("账号导入失败：#2 request for [REDACTED] failed；#8 refresh [REDACTED] expired");
});

test("redacts upstream user identifiers from database errors", () => {
  expect(importFailure({ ok: false, error: "lookup failed for user-sensitive-id" }))
    .toBe("lookup failed for [REDACTED]");
});

test("archives submitted JSON in the local state directory with owner-only permissions", () => {
  const directory = join(mkdtempSync(join(tmpdir(), "apistate-import-archive-")), "account-imports");
  const content = JSON.stringify({ accounts: [], proxies: [] });
  const fileName = archiveAccountImportContent(directory, "job-fixture", content);
  const path = join(directory, fileName);
  expect(fileName).toBe("job-fixture.json");
  expect(readFileSync(path, "utf8")).toBe(content);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("runtime import idempotency is stable inside one job and isolated across jobs", () => {
  const payload = { accounts: [{ name: "same-account" }] };
  expect(runtimeImportIdempotencyKey("job-a", payload)).toBe(runtimeImportIdempotencyKey("job-a", payload));
  expect(runtimeImportIdempotencyKey("job-a", payload)).not.toBe(runtimeImportIdempotencyKey("job-b", payload));
});

test("classifies timeout reconciliation without charging pre-existing updates as new purchases", () => {
  const base = {
    content: JSON.stringify({ accounts: [] }), sourceIndexes: [2, 3],
    skipped: [{ index: 1, accountId: 395 }], pendingExisting: [{ index: 2, accountId: 396 }],
    initialProxyId: 49, proxyCandidateIds: [49],
  } satisfies AccountImportPreflightPlan;
  const reconciled = {
    ...base, sourceIndexes: [], pendingExisting: [],
    skipped: [{ index: 1, accountId: 395 }, { index: 2, accountId: 396 }, { index: 3, accountId: 397 }],
  } satisfies AccountImportPreflightPlan;
  const output = recoveredImportOutput({
    id: "job", fingerprint: "fingerprint", accountCount: 3,
    settings: { perAccountProxy: false },
  } as never, base, reconciled);
  expect(output.result).toEqual(expect.objectContaining({
    createdIds: [397], updatedIds: [396], skippedIds: [395], failed: 0,
  }));
  expect(output.recoveredAfterTimeout).toBe(true);
  expect(isTimeoutError(new DOMException("The operation timed out.", "TimeoutError"))).toBe(true);
});
