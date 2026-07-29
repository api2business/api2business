import { expect, test } from "bun:test";
import { importFailure } from "./account-import-service";

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
