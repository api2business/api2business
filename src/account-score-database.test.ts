import { expect, test } from "bun:test";
import { recentAccountAggregateQuery, scoreRecentDatabaseRow, weightedPercentile } from "./account-score-database";

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
  expect(recentAccountAggregateQuery).toContain("a.type AS account_type");
  expect(recentAccountAggregateQuery).toContain("LOWER(TRIM(COALESCE(a.type, ''))) <> 'oauth'");
  expect(recentAccountAggregateQuery).toContain("selected_g.id::text = $3::text");
  expect(recentAccountAggregateQuery).toContain("selected_g.name = $3::text");
  expect(recentAccountAggregateQuery).toContain("AND e.kind = 'usage'");
  expect(recentAccountAggregateQuery).toContain("e.client_status_code >= 400");
  expect(recentAccountAggregateQuery).toContain("o.status_code::int AS client_status_code");
  expect(recentAccountAggregateQuery).toContain("o.upstream_status_code::int AS upstream_status_code");
  expect(recentAccountAggregateQuery).toContain("AND NOT (COALESCE(o.status_code, o.upstream_status_code, 0) BETWEEN 200 AND 399)");
  expect(recentAccountAggregateQuery).toContain("PARTITION BY COALESCE(candidate.request_id::text");
  expect(recentAccountAggregateQuery).toContain("ORDER BY (candidate.kind = 'usage') DESC");
  expect(recentAccountAggregateQuery).not.toContain("openai.request_completed");
  expect(recentAccountAggregateQuery).toContain("AS failover_recovered");
  expect(recentAccountAggregateQuery).toContain("AS failover_failed");
  expect(recentAccountAggregateQuery).toContain("%insufficient_balance%");
  expect(recentAccountAggregateQuery).toContain("%insufficient account balance%");
  expect(recentAccountAggregateQuery).toContain("'/v1/messages', '/v1/responses', '/responses/compact', '/v1/responses/compact'");
  expect(recentAccountAggregateQuery).toContain("%余额不足%");
  expect(recentAccountAggregateQuery).toContain("o.upstream_error_detail");
  expect(recentAccountAggregateQuery).toContain("e.kind = 'usage' OR e.scoreable");
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
  expect(row.availabilityReason).toMatchObject({ code: "account-error", label: "账号错误" });
  expect(row.currentStateScoreImpact).toBe("none");
  expect(row.priority).toBe(5);
  expect(row.accountType).toBeNull();
});

test("账务额度不足样本保留审计但不参与质量评分", () => {
  const row = scoreRecentDatabaseRow({
    account_id: 370,
    account_name: "https://quality.example.com pro 0.1",
    status: "active",
    schedulable: true,
    priority: 205,
    group_ids: [2, 3, 10],
    group_names: ["pool", "self", "probe"],
    success_requests: 4,
    failure_requests: 2,
    customer_error_requests: 38,
    excluded_error_requests: 36,
    attributed_requests: 6,
    failover_requests: 0,
    failover_recovered: 0,
    failover_failed: 0,
    burst_attempts: 6,
    burst_failure_requests: 2,
    stream_success_requests: 0,
    first_token_samples: 0,
    duration_p95_ms: 19598,
    selected_calls: 40,
  }, 1000, scorePolicy);

  expect(row.customerErrorRequests).toBe(38);
  expect(row.excludedNonUpstreamErrorRequests).toBe(36);
  expect(row.observedAttempts).toBe(6);
  expect(row.failureRequests).toBe(2);
  expect(row.failoverRequests).toBe(0);
  expect(row.score).toBe(30.8);
  expect(row.grade).toBe("E");
});

test("unavailable reasons distinguish weekly quota, billing, authentication, and missing evidence", () => {
  const base = {
    account_id: 1, account_name: "account", status: "active", schedulable: true,
    priority: 1, group_ids: [2], group_names: ["pool"], selected_calls: 0,
  };
  const reason = (overrides: Record<string, unknown>, patterns: string[] = []) => scoreRecentDatabaseRow(
    { ...base, ...overrides }, 1000, scorePolicy, Date.parse("2026-07-29T00:00:00Z"), patterns,
  ).availabilityReason;

  expect(reason({ weekly_remaining_percent: 0 })).toMatchObject({ code: "weekly-quota", label: "周限额已用尽" });
  expect(reason({ status: "error", schedulable: false, error_message: "用户额度不足" }, ["用户额度不足"]))
    .toMatchObject({ code: "billing-depleted", label: "费用不足" });
  expect(reason({ status: "error", schedulable: false, error_message: "Token revoked: authentication token invalidated" }))
    .toMatchObject({ code: "authentication", label: "鉴权失效" });
  expect(reason({ schedulable: false })).toMatchObject({ code: "unschedulable", label: "已停止调度" });
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

test("sample count does not reduce score or grade", () => {
  const successful = scoreRecentDatabaseRow({
    account_id: 41,
    account_name: "one-success 0.08",
    status: "active",
    schedulable: true,
    priority: 1,
    group_ids: [2],
    group_names: ["pool"],
    success_requests: 1,
    failure_requests: 0,
    selected_calls: 1,
  }, 1000, scorePolicy);
  const failed = scoreRecentDatabaseRow({
    account_id: 42,
    account_name: "one-failure 0.08",
    status: "active",
    schedulable: true,
    priority: 1,
    group_ids: [2],
    group_names: ["pool"],
    success_requests: 0,
    failure_requests: 1,
    selected_calls: 1,
  }, 1000, scorePolicy);

  expect(successful).toMatchObject({ score: 100, grade: "A", confidence: "low", scoreComparable: false });
  expect(failed).toMatchObject({ grade: "E", confidence: "low", scoreComparable: false });
  expect(Number(failed.score)).toBeLessThan(60);
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
    failover_failed: 1,
    failover_aborted: 1,
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
  expect(recovered.failoverFailed).toBe(1);
  expect(recovered.failoverAborted).toBe(1);
  expect(recovered.failoverNotTriggered).toBe(0);
  expect(recovered.failoverOutcomeMissing).toBe(0);
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

test("database score window expires old samples and applies 100-call decay buckets", () => {
  expect(recentAccountAggregateQuery).toContain("created_at >= NOW() - ($5::int * INTERVAL '1 hour')");
  expect(recentAccountAggregateQuery).toContain("FLOOR((ranked.recent_rank - 1)::numeric / $6::numeric)");
  const weights = Array.from({ length: 1000 }, (_, index) => Math.max(0.1, 1 - Math.floor(index / 100) * 0.1));
  expect(Math.round(weights.reduce((sum, weight) => sum + weight, 0) * 10) / 10).toBe(550);
});

test("weighted percentile gives newer samples their declared influence", () => {
  expect(weightedPercentile([100, 200, 300], [1, 1, 8], 0.5)).toBe(300);
  expect(weightedPercentile([100, 200, 300], [8, 1, 1], 0.5)).toBe(100);
  expect(weightedPercentile([], [], 0.95)).toBeNull();
});
