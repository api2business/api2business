import { expect, test } from "bun:test";
import { errorGetQuery, errorListQuery, projectErrorDetailRow } from "./error-detail-database";

test("error detail queries are bounded and request scoped", () => {
  expect(errorListQuery).toContain("LIMIT $1");
  expect(errorListQuery).not.toContain("COALESCE(is_business_limited, false) = false");
  expect(errorListQuery).toContain("COALESCE(status_code, 0) >= 400");
  expect(errorGetQuery).toContain("WHERE request_id = $1");
  expect(errorListQuery).not.toContain("SET TRANSACTION READ ONLY");
});

test("error detail projection masks identity and excludes bodies", () => {
  const row = projectErrorDetailRow({
    id: 1,
    request_id: "req-1",
    user_email: "Hi-ShuXS@test.com",
    api_key_name: "CODEX",
    api_key_prefix: "sk-63860",
    account_id: 65,
    account_name: "https://errors.example.com plus 0.035",
    display_status_code: 503,
    recorded_status_code: 499,
    upstream_status_code: 503,
    recovered: false,
    stable_phrases: { modelNotFound: true },
    created_at: new Date("2026-07-27T08:03:34Z"),
    error_body: "must not escape",
  }, "Asia/Shanghai");
  expect(row.user).toBe("Hi-***");
  expect(row.customerVisible).toBeTrue();
  expect(row.statusCode).toBe(503);
  expect(row.recordedStatusCode).toBe(499);
  expect(row.upstreamStatusCode).toBe(503);
  expect(row).not.toHaveProperty("error_body");
});

test("error category follows Sub2API native phase and type mapping", () => {
  const row = projectErrorDetailRow({
    id: 2,
    error_phase: "request",
    error_type: "api_error",
    category: "quota",
    recorded_status_code: 502,
  }, "Asia/Shanghai");
  expect(row.category).toBe("quota");
  expect(row.customerVisible).toBeTrue();
});

test("native error list keeps business-limited rows visible", () => {
  const row = projectErrorDetailRow({
    id: 3,
    error_phase: "request",
    error_type: "billing_error",
    category: "quota",
    recorded_status_code: 429,
    display_status_code: 429,
    is_business_limited: true,
  }, "Asia/Shanghai");
  expect(row.businessLimited).toBeTrue();
  expect(row.category).toBe("quota");
  expect(row.customerVisible).toBeTrue();
});
