import { expect, test } from "bun:test";
import { importFailure } from "./account-import-service";

test("projects nested CLI errors without exposing credentials", () => {
  const message = importFailure({ ok: false, error: { code: "runtime_failed", message: "login failed for user@example.com with sk-secret" } });
  expect(message).toBe("runtime_failed: login failed for [REDACTED] with [REDACTED]");
});

test("projects nested runtime errors", () => {
  expect(importFailure({ ok: false, data: { runtime: { error: "source proxy 3 does not exist" } } })).toBe("source proxy 3 does not exist");
});
