import { expect, test } from "bun:test";
import { recentAccountAggregateQuery, scoreRecentDatabaseRow } from "./account-score-database";

const scorePolicy = {
  reliabilityWeight: 45,
  failoverWeight: 10,
  latencyWeight: 35,
  baselineWeight: 10,
  failureZeroScoreRate: 0.2,
  failureBurstCallLimit: 100,
  failoverZeroScoreRate: 0.2,
  ttftFullScoreMs: 5_000,
  ttftZeroScoreMs: 55_000,
};

test("database aggregate uses bounded account indexes and current state is display-only", () => {
  expect(recentAccountAggregateQuery).toContain("WHERE u.account_id = a.account_id");
  expect(recentAccountAggregateQuery).toContain("WHERE o.account_id = a.account_id");
  expect(recentAccountAggregateQuery).toContain("COALESCE(o.upstream_status_code, 0) >= 400");
  expect(recentAccountAggregateQuery).toContain("e.recent_rank <= $4");
  expect(recentAccountAggregateQuery.match(/LIMIT \$1/gu)?.length).toBe(3);
  expect(recentAccountAggregateQuery).toContain("a.name = $2::text");
  expect(recentAccountAggregateQuery).toContain("selected_g.id::text = $3::text");
  expect(recentAccountAggregateQuery).toContain("selected_g.name = $3::text");
  expect(recentAccountAggregateQuery).toContain("recovery.request_id = e.request_id");
  expect(recentAccountAggregateQuery).toContain("WHERE f.triggered");
  expect(recentAccountAggregateQuery).toContain("AS failover_recovered");
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
  }, 500, scorePolicy, Date.parse("2026-07-23T00:00:00Z"));

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
  }, 2000, scorePolicy)).not.toThrow();
});

test("database score always projects failover and recovered request counts", () => {
  const recovered = scoreRecentDatabaseRow({
    account_id: 2,
    account_name: "recovered 0.05",
    status: "active",
    schedulable: true,
    priority: 1,
    group_ids: [2],
    group_names: ["pool"],
    success_requests: 100,
    attributed_requests: 100,
    failover_requests: 3,
    failover_recovered: 2,
    failure_requests: 0,
    stream_success_requests: 100,
    first_token_samples: 100,
    ttft_p95_ms: 5000,
    selected_calls: 100,
  }, 1000, scorePolicy);
  const zero = scoreRecentDatabaseRow({
    account_id: 3,
    account_name: "zero 0.05",
    status: "active",
    schedulable: true,
    priority: 1,
    group_ids: [2],
    group_names: ["pool"],
    success_requests: 100,
    attributed_requests: 100,
    failure_requests: 0,
    stream_success_requests: 100,
    first_token_samples: 100,
    ttft_p95_ms: 5000,
    selected_calls: 100,
  }, 1000, scorePolicy);

  expect(recovered.failoverRequests).toBe(3);
  expect(recovered.failoverRecovered).toBe(2);
  expect(recovered.failoverOutcomeMissing).toBe(1);
  expect(zero.failoverRequests).toBe(0);
  expect(zero.failoverRecovered).toBe(0);
});

test("TTFT weight curve keeps latency above 20 seconds below grade A", () => {
  const row = scoreRecentDatabaseRow({
    account_id: 2,
    account_name: "slow-perfect",
    status: "active",
    schedulable: true,
    priority: 1,
    group_ids: [2],
    group_names: ["pool"],
    success_requests: 1000,
    attributed_requests: 1000,
    failover_requests: 0,
    failure_requests: 0,
    stream_success_requests: 1000,
    first_token_samples: 1000,
    ttft_p95_ms: 20_001,
    selected_calls: 1000,
  }, 1000, scorePolicy);

  expect(row.score).toBeLessThan(90);
  expect(row.grade).toBe("B");
});

test("short-window upstream burst cannot be diluted by long-window success", () => {
  const row = scoreRecentDatabaseRow({
    account_id: 32,
    account_name: "stable-until-now 0.07",
    status: "active",
    schedulable: true,
    priority: 1,
    group_ids: [2],
    group_names: ["pool"],
    success_requests: 990,
    attributed_requests: 1000,
    failover_requests: 0,
    failure_requests: 10,
    burst_attempts: 100,
    burst_failure_requests: 10,
    stream_success_requests: 900,
    first_token_samples: 900,
    ttft_p95_ms: 10_000,
    selected_calls: 1000,
  }, 1000, scorePolicy);

  expect(row.failureRate).toBe(0.01);
  expect(row.burstFailureRate).toBe(0.1);
  expect(row.effectiveFailureRate).toBe(0.1);
  expect(row.score).toBeLessThan(80);
  expect(row.grade).toBe("C");
});
