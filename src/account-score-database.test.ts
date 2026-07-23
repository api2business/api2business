import { expect, test } from "bun:test";
import { recentAccountAggregateQuery, scoreRecentDatabaseRow } from "./account-score-database";

test("database aggregate uses bounded account indexes and current state is display-only", () => {
  expect(recentAccountAggregateQuery).toContain("WHERE u.account_id = a.account_id");
  expect(recentAccountAggregateQuery).toContain("WHERE o.account_id = a.account_id");
  expect(recentAccountAggregateQuery.match(/LIMIT \$1/gu)?.length).toBe(3);
  expect(recentAccountAggregateQuery).toContain("a.name = $2::text");
  expect(recentAccountAggregateQuery).not.toContain("start_time");

  const row = scoreRecentDatabaseRow({
    account_id: 9,
    account_name: "empty-balance 0.1",
    status: "error",
    schedulable: false,
    error_message: "Insufficient account balance",
    priority: 5,
    group_ids: [2],
    group_names: ["pool"],
    success_requests: 100,
    failure_requests: 0,
    customer_error_requests: 0,
    excluded_error_requests: 0,
    stream_success_requests: 100,
    first_token_samples: 100,
    ttft_p50_ms: 4_000,
    ttft_p95_ms: 5_000,
    ttft_p99_ms: 6_000,
    ttft_max_ms: 7_000,
    duration_p95_ms: 10_000,
    token_count: 2_000,
    api_amount_usd: 1,
    selected_calls: 100,
  }, 500, Date.parse("2026-07-23T00:00:00Z"));

  expect(row.score).toBe(100);
  expect(row.grade).toBe("A");
  expect(row.currentAvailable).toBe(false);
  expect(row.currentStateScoreImpact).toBe("none");
  expect(row.priority).toBe(5);
});

test("database aggregate accepts a 2000-call analysis window", () => {
  expect(() => scoreRecentDatabaseRow({
    account_id: 1,
    account_name: "account",
    status: "active",
    schedulable: true,
    priority: 1,
    group_ids: [2],
    group_names: ["pool"],
    success_requests: 2000,
    failure_requests: 0,
    stream_success_requests: 2000,
    first_token_samples: 2000,
    ttft_p95_ms: 5000,
    selected_calls: 2000,
  }, 2000)).not.toThrow();
});
