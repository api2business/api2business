import { expect, test } from "bun:test";
import { collectPoolQualitySample, poolQualityHistory } from "./pool-quality-monitor";
import { loadConfig } from "./config";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

test("pool quality uses one queued query and separates exact upstream accounts", async () => {
  let queries = 0;
  const reads = {
    async query(input: { parameters: unknown[] }) {
      queries += 1;
      expect(input.parameters).toEqual([1000, "2,3"]);
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
  const sample = await collectPoolQualitySample(loadConfig("config/sub2rank.yaml"), reads, "2026-08-03T00:00:00.000Z");
  expect(queries).toBe(1);
  expect(sample.observedAttempts).toBe(3);
  expect(sample.participation).toHaveLength(2);
  expect(sample.failureRequests).toBe(1);
  expect(sample.participation).toEqual([
    { accountId: 10, accountName: "https://api.example.com plus 0.05", baseUrl: "https://api.example.com/v1", attempts: 2, ratio: 0.666667, costRateCnyPerApiUsd: 0.05, costSource: "manual" },
    { accountId: 11, accountName: "https://api.example.com pro 0.08", baseUrl: "https://api.example.com", attempts: 1, ratio: 0.333333, costRateCnyPerApiUsd: 0.08, costSource: "manual" },
  ]);
});

test("pool quality history preserves bounded chart fields", () => {
  expect(poolQualityHistory([{ sampled_at: "2026-08-03T00:00:00Z", score: "88.5", failure_rate: "0.02", ttft_p95_ms: 2500 }])).toEqual([
    { sampledAt: "2026-08-03T00:00:00.000Z", score: 88.5, failureRate: 0.02, ttftP95Ms: 2500, rollingScore: 88.5 },
  ]);
});
