import { expect, test } from "bun:test";
import { errorAggregateQuery, projectErrorAggregateRow } from "./error-aggregate-database";

test("error aggregate is one bounded database query with recovered request detection", () => {
  expect(errorAggregateQuery).toContain("ORDER BY o.created_at DESC, o.id DESC");
  expect(errorAggregateQuery).toContain("LIMIT $1");
  expect(errorAggregateQuery).toContain("u.request_id = e.request_id");
  expect(errorAggregateQuery).toContain("GROUP BY request_key");
  expect(errorAggregateQuery).toContain("rank <= $4");
  expect(errorAggregateQuery).toContain("a.name = $2::text");
  expect(errorAggregateQuery).toContain("g.name = $3::text");
  expect(errorAggregateQuery).toContain("request_group.id = o.group_id");
  expect(errorAggregateQuery).toContain("api2business-probe-%");
  expect(errorAggregateQuery).toContain("probe.id = o.api_key_id");
  expect(errorAggregateQuery).not.toContain("account_groups");
  expect(errorAggregateQuery).not.toContain("o.*");
  expect(errorAggregateQuery).toContain("e.status_code IN (502, 503, 504, 524)");
  expect(errorAggregateQuery).toContain("e.upstream_status_code IN (502, 503, 504, 524)");
  expect(errorAggregateQuery).toContain("AND NOT (COALESCE(o.status_code, o.upstream_status_code, 0) BETWEEN 200 AND 399)");
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
