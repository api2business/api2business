import { expect, test } from "bun:test";
import type { AppConfig } from "./config";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import {
  collectErrorAggregateFromDatabase,
  errorAggregateQuery,
  projectErrorAggregateRow,
} from "./error-aggregate-database";

test("error aggregate is one bounded database query with recovered request detection", () => {
  expect(errorAggregateQuery).toContain("ORDER BY o.created_at DESC, o.id DESC");
  expect(errorAggregateQuery).toContain("LIMIT $1");
  expect(errorAggregateQuery).toContain("selected_errors AS MATERIALIZED");
  expect(errorAggregateQuery).toContain("usage_recovery_keys AS MATERIALIZED");
  expect(errorAggregateQuery).toContain("terminal_policy_keys AS MATERIALIZED");
  expect(errorAggregateQuery).toContain("u.request_id = e.request_id");
  expect(errorAggregateQuery).toContain("u.request_id = 'client:' ||");
  expect(errorAggregateQuery).toContain("GROUP BY request_key");
  expect(errorAggregateQuery).toContain("rank <= $4");
  expect(errorAggregateQuery).toContain("a.name = $2::text");
  expect(errorAggregateQuery).toContain("g.name = $3::text");
  expect(errorAggregateQuery).toContain("request_group.id = o.group_id");
  expect(errorAggregateQuery).toContain("account_selector_matches");
  expect(errorAggregateQuery).toContain("group_selector_matches");
  expect(errorAggregateQuery).toContain("api2business-probe-%");
  expect(errorAggregateQuery).toContain("probe.id = o.api_key_id");
  expect(errorAggregateQuery).not.toContain("account_groups");
  expect(errorAggregateQuery).not.toContain("o.*");
  expect(errorAggregateQuery).toContain("e.status_code IN (502, 503, 504, 524)");
  expect(errorAggregateQuery).toContain("e.upstream_status_code IN (502, 503, 504, 524)");
  expect(errorAggregateQuery).toContain("AND (NOT (COALESCE(o.status_code, o.upstream_status_code, 0) BETWEEN 200 AND 399)");
  expect(errorAggregateQuery).toContain("OR COALESCE(o.upstream_status_code, 0) >= 400");
  expect(errorAggregateQuery).toContain("OR (o.error_phase='request' AND o.error_type='cyber_policy')");
  expect(errorAggregateQuery).toContain("o.created_at >= $5::timestamptz");
  expect(errorAggregateQuery).toContain("o.created_at < $6::timestamptz");
  expect(errorAggregateQuery).toContain('terminal.request_id = e.request_id');
  expect(errorAggregateQuery).not.toContain("OR u.request_id IN");
  expect(errorAggregateQuery).not.toContain("error_body");
  expect(errorAggregateQuery).not.toContain("api_key_prefix");
});

test("error aggregate projection omits raw error content", () => {
  const projected = projectErrorAggregateRow({
    sampled_error_rows: 3,
    distinct_requests: 2,
    customer_visible_requests: 1,
    recovered_requests: 1,
    stream_requests: 1,
    dimensions: { family: [{ key: "rate_limit", requests: 2 }] },
  }, "Asia/Shanghai");
  expect(projected.sampledErrorRows).toBe(3);
  expect(projected.customerVisibleRequests).toBe(1);
  expect(projected.dimensions).toEqual({ family: [{ key: "rate_limit", requests: 2 }] });
  expect(projected).not.toHaveProperty("errorMessage");
  expect(projected).not.toHaveProperty("errorBody");
});

test("error aggregate keeps an empty window successful when the account exists", async () => {
  const reads = {
    query: async () => ({
      rows: [{
        account_selector_matches: 1,
        group_selector_matches: null,
        sampled_error_rows: 0,
        distinct_requests: 0,
        customer_visible_requests: 0,
        recovered_requests: 0,
        stream_requests: 0,
        dimensions: {},
      }],
      queueDurationMs: 0,
      queryDurationMs: 1,
      queryStartedAt: "2026-11-10T11:20:00.000Z",
      queryCompletedAt: "2026-11-10T11:20:00.001Z",
      deduplicated: false,
      cached: false,
    }),
  } as unknown as Sub2ApiReadClient;

  const aggregate = await collectErrorAggregateFromDatabase(
    { monitor: { timezone: "Asia/Shanghai" } } as AppConfig,
    reads,
    100,
    100,
    "1556",
    null,
    "2026-11-10T09:17:00.000Z",
    "2026-11-10T11:17:00.000Z",
  );

  expect(aggregate.sampledErrorRows).toBe(0);
  expect(aggregate.accountSelectorMatches).toBe(1);
  expect(aggregate.customerVisibleRequests).toBe(0);
});

test("error aggregate still rejects an unknown account selector", async () => {
  const reads = {
    query: async () => ({
      rows: [{
        account_selector_matches: 0,
        group_selector_matches: null,
        sampled_error_rows: 0,
        dimensions: {},
      }],
      queueDurationMs: 0,
      queryDurationMs: 1,
      queryStartedAt: "2026-11-10T11:20:00.000Z",
      queryCompletedAt: "2026-11-10T11:20:00.001Z",
      deduplicated: false,
      cached: false,
    }),
  } as unknown as Sub2ApiReadClient;

  await expect(collectErrorAggregateFromDatabase(
    { monitor: { timezone: "Asia/Shanghai" } } as AppConfig,
    reads,
    100,
    100,
    "999999",
  )).rejects.toThrow("account selector did not match an account");
});
