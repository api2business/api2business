import { expect, test } from "bun:test";
import { collectPoolQualityErrors, collectPoolQualitySample, poolQualityErrorsSql, poolQualityHistory, poolQualitySql } from "./pool-quality-monitor";
import { loadConfig } from "./config";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

test("pool quality uses one queued query and separates exact upstream accounts", async () => {
  let queries = 0;
  const reads = {
    async query(input: { parameters: unknown[] }) {
      queries += 1;
      expect(input.parameters).toEqual([1000, "2,3", "2026-08-03T00:00:00.000Z"]);
      return {
        rows: [
          { id: 1, kind: "usage", request_id: "a", account_id: 10, account_name: "https://api.example.com plus 0.05", base_url: "https://api.example.com/v1", stream: true, first_token_ms: 1000, duration_ms: 2000, scoreable: false, failover_triggered: false },
          { id: 2, kind: "usage", request_id: "b", account_id: 11, account_name: "https://api.example.com pro 0.08", base_url: "https://api.example.com", stream: true, first_token_ms: 1200, duration_ms: 2100, scoreable: false, failover_triggered: false },
          { id: 3, kind: "error", request_id: "c", account_id: 10, account_name: "https://api.example.com plus 0.05", base_url: "https://api.example.com/v1", stream: false, first_token_ms: null, duration_ms: 500, scoreable: true, client_status_code: 502, failover_triggered: true },
        ],
        cached: false, deduplicated: false, queueDurationMs: 1, queryDurationMs: 2,
        totalDurationMs: 3, queryStartedAt: new Date().toISOString(), queryCompletedAt: new Date().toISOString(),
      };
    },
    status() { throw new Error("not used"); },
  } as unknown as Sub2ApiReadClient;
  const sample = await collectPoolQualitySample(loadConfig("config/api2business.example.yaml"), reads, "2026-08-03T00:00:00.000Z");
  expect(queries).toBe(1);
  expect(sample.observedAttempts).toBe(3);
  expect(sample.participation).toHaveLength(2);
  expect(sample.failureRequests).toBe(1);
  expect(sample.errorAttribution).toEqual({ total: 1, attributed: 1, unattributed: 0, completenessRate: 1 });
  expect(sample.participation).toEqual([
    { accountId: 10, accountName: "https://api.example.com plus 0.05", baseUrl: "https://api.example.com/v1", attempts: 2, ratio: 0.666667, costRateCnyPerApiUsd: 0.05, costSource: "manual" },
    { accountId: 11, accountName: "https://api.example.com pro 0.08", baseUrl: "https://api.example.com", attempts: 1, ratio: 0.333333, costRateCnyPerApiUsd: 0.08, costSource: "manual" },
  ]);
});

test("pool quality applies the same recent-call decay buckets as account scoring", async () => {
  const config = loadConfig("config/api2business.example.yaml");
  config.sub2api.scoreSamplePolicy.decayBucketSize = 1;
  config.sub2api.scoreSamplePolicy.decayStep = 0.5;
  config.sub2api.scoreSamplePolicy.minimumWeight = 0.1;
  const reads = {
    async query() {
      return {
        rows: [
          { id: 1, kind: "usage", request_id: "new", account_id: 10, account_name: "new", base_url: "https://new", stream: true, first_token_ms: 1000, duration_ms: 2000, scoreable: false, failover_triggered: false },
          { id: 2, kind: "error", request_id: "old", account_id: 11, account_name: "old", base_url: "https://old", stream: false, first_token_ms: null, duration_ms: null, scoreable: true, client_status_code: 502, failover_triggered: false },
        ],
        cached: false, deduplicated: false, queueDurationMs: 1, queryDurationMs: 2,
        totalDurationMs: 3, queryStartedAt: new Date().toISOString(), queryCompletedAt: new Date().toISOString(),
      };
    },
    status() { throw new Error("not used"); },
  } as unknown as Sub2ApiReadClient;
  const sample = await collectPoolQualitySample(config, reads, "2026-08-03T00:00:00.000Z");
  expect(sample.effectiveSampleWeight).toBe(1.5);
  expect(sample.successRequests).toBe(1);
  expect(sample.failureRequests).toBe(0.5);
  expect(sample.observedAttempts).toBe(1.5);
  expect(sample.sampleWeighting).toBe("recent-call-decay-buckets");
  expect(sample.participation[0]).toMatchObject({ accountId: 10, attempts: 1, ratio: 0.666667 });
  expect(sample.participation[1]).toMatchObject({ accountId: 11, attempts: 0.5, ratio: 0.333333 });
});

test("pool quality excludes every monitor-user key without changing account scoring", () => {
  expect(poolQualitySql).toContain("owner.email = 'monitor-user@sub2api.platform-infra.local'");
  expect(poolQualitySql).not.toContain("k.name LIKE");
  expect(poolQualitySql).toContain("p.id = u.api_key_id");
  expect(poolQualitySql).toContain("p.id = o.api_key_id");
  expect(poolQualitySql).toContain("LEFT JOIN target_accounts a ON a.id = o.account_id");
  expect(poolQualitySql).toContain("o.group_id = ANY(string_to_array($2, ',')::bigint[])");
  expect(poolQualitySql).toContain("'%insufficient_balance%'");
  expect(poolQualitySql).toContain("'%balance is insufficient%'");
  expect(poolQualitySql).toContain("'%model_not_found%'");
  expect(poolQualitySql).toContain("'%model not found%'");
  expect(poolQualitySql).toContain("'%model_no_found%'");
  expect(poolQualitySql).toContain("'%moddel_no_found%'");
  expect(poolQualitySql).toContain("'%model does not exist%'");
  expect(poolQualitySql.indexOf("'%model_not_found%'")).toBeLessThan(poolQualitySql.indexOf("WHEN source.error_phase = 'upstream'"));
  expect(poolQualitySql).toContain("PARTITION BY event.request_id");
  expect(poolQualitySql).toContain("(event.kind = 'usage') DESC");
  expect(poolQualitySql).toContain("AND NOT (COALESCE(o.status_code, o.upstream_status_code, 0) BETWEEN 200 AND 399)");
  expect(poolQualitySql).toContain("'/responses/compact'");
  expect(poolQualitySql).toContain("'/v1/responses/compact'");
  expect(poolQualitySql.match(/NOT LIKE '%luna%'/gu)?.length).toBe(2);
  expect(poolQualitySql).not.toContain("FROM ops_error_logs o\n        WHERE");
});

test("pool quality errors use the same bounded window and expose paginated model evidence", async () => {
  let request: { parameters: unknown[]; sql: string } | null = null;
  const reads = {
    async query(input: { parameters: unknown[]; sql: string }) {
      request = input;
      return {
        rows: [{ total_count: 107, rows: [{ requestId: "r1", model: "gpt-5.6-sol" }], model_distribution: [{ model: "gpt-5.6-sol", count: 107 }] }],
        cached: false, deduplicated: false, queueDurationMs: 1, queryDurationMs: 2,
        totalDurationMs: 3, queryStartedAt: new Date().toISOString(), queryCompletedAt: new Date().toISOString(),
      };
    },
    status() { throw new Error("not used"); },
  } as unknown as Sub2ApiReadClient;
  const result = await collectPoolQualityErrors(loadConfig("config/api2business.yaml"), reads, {
    sampledAt: "2026-08-05T22:12:43Z", page: 2, pageSize: 20, filter: "scoreable",
  });
  expect(request?.parameters).toEqual([1000, "2,3", "2026-08-05T22:12:43.000Z", "scoreable", 20, 20]);
  expect(request?.sql).toContain("PARTITION BY event.request_id");
  expect(request?.sql).toContain("requested_model");
  expect(request?.sql).toContain("requester.email AS user_email");
  expect(request?.sql).toContain("'userEmail', user_email");
  expect(request?.sql.match(/NOT LIKE '%luna%'/gu)?.length).toBe(2);
  expect(request?.sql).toContain("AND NOT (COALESCE(e.client_status_code, e.upstream_status_code, 0) BETWEEN 200 AND 399)");
  expect(result.pagination).toEqual({ page: 2, pageSize: 20, total: 107, totalPages: 6 });
  expect(result.modelDistribution).toEqual([{ model: "gpt-5.6-sol", count: 107 }]);
});

test("pool quality has an independent YAML score policy without failover points", () => {
  const config = loadConfig("config/api2business.yaml");
  expect(config.sub2api.poolScorePolicy.failoverWeight).toBe(0);
  expect(config.sub2api.poolScorePolicy.reliabilityWeight).toBe(58);
  expect(config.sub2api.scorePolicy.failoverWeight).toBe(10);
});

test("pool quality history preserves bounded chart fields", () => {
  expect(poolQualityHistory([{ sampled_at: "2026-08-03T00:00:00Z", score: "88.5", failure_rate: "0.02", ttft_p95_ms: 2500 }])).toEqual([
    { sampledAt: "2026-08-03T00:00:00.000Z", score: 88.5, failureRate: 0.02, ttftP95Ms: 2500, rollingScore: 88.5 },
  ]);
});
