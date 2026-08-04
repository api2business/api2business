import { expect, test } from "bun:test";
import { maskIdentity, parseImpactWindow, userImpactQuery } from "./user-impact-database";

test("parses offset-free impact windows in the owning timezone", () => {
  const window = parseImpactWindow("2026-07-23T16:00:00", "2026-07-23T17:00:00", "Asia/Shanghai");
  expect(window.startUtc).toStartWith("2026-07-23T08:00:00");
  expect(window.endUtc).toStartWith("2026-07-23T09:00:00");
  expect(window.timezone).toBe("Asia/Shanghai");
});

test("masks identities with at most three visible prefix characters", () => {
  expect(maskIdentity("wenrui")).toBe("wen***");
  expect(maskIdentity("bo")).toBe("bo***");
  expect(maskIdentity("customer@example.com", true)).toBe("cus***@example.com");
});

test("uses one bounded database aggregation and excludes recovered requests", () => {
  expect(userImpactQuery).toContain("created_at >= $1::timestamptz");
  expect(userImpactQuery).toContain("created_at < $2::timestamptz");
  expect(userImpactQuery).toContain("infrastructure_failure IS TRUE AND success_key IS NULL");
  expect(userImpactQuery).toContain("NOT IN ('client', 'business')");
  expect(userImpactQuery).toContain("COALESCE(is_business_limited, false) IS FALSE");
  expect(userImpactQuery).toContain("LOWER(COALESCE(u.role, '')) <> 'admin'");
});
