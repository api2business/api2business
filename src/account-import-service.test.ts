import { expect, test } from "bun:test";
import { AccountImportService, importFailure } from "./account-import-service";
import type { AppConfig } from "./config";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

test("projects YAML-owned account import defaults", () => {
  const service = new AccountImportService({ operations: { accountImportDefaults: {
    priority: 1, capacity: 16, groupIds: [2, 3], sourceProxyId: 3,
  } } } as AppConfig, {} as Sub2ApiReadClient);
  expect(service.options().defaults).toEqual({
    priority: 1, capacity: 16, groupIds: [2, 3], sourceProxyId: 3, unitCostCny: null,
  });
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
