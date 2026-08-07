import { describe, expect, test } from "bun:test";
import { aggregateNativeGroupScore, collectNativeScores } from "./account-score-native";
import type { Sub2ApiClient } from "./sub2api-client";

const availableOps = { status: "available" as const, data: {}, reason: null };

describe("aggregateNativeGroupScore", () => {
  test("scores upstream failures and excludes client input locally", () => {
    const group = { id: 2, name: "pool", platform: "openai", status: "active" };
    const account = { id: 15, name: "primary 0.02", platform: "openai", status: "active", schedulable: true, priority: 1 };
    const usage = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      account_id: 15,
      group_id: 2,
      model: "gpt-test",
      stream: true,
      input_tokens: 100,
      output_tokens: 20,
      actual_cost: 0.1,
      duration_ms: 20_000,
      first_token_ms: 5_000 + index,
      created_at: "2026-07-17T09:00:00Z",
    }));
    const result = aggregateNativeGroupScore({
      group,
      accounts: [account],
      usage,
      requestErrors: [
        { id: 1, request_id: "req-fail", account_id: 15, status_code: 502, phase: "upstream", type: "upstream_error", message: "Upstream service temporarily unavailable" },
        { id: 2, request_id: "req-input", account_id: 15, status_code: 400, phase: "client", type: "invalid_request", message: "Input must be a list" },
      ],
      systemLogs: [
        { id: 10, created_at: "2026-07-17T09:01:00Z", message: "openai.upstream_failover_switching", request_id: "req-fail", account_id: 15, extra: { group_id: 2 } },
        { id: 11, created_at: "2026-07-17T09:01:01Z", message: "http request completed", request_id: "req-fail", account_id: 15, extra: { group_id: 2, status_code: 200 } },
      ],
      overview: {
        request_count_total: 22,
        error_count_total: 1,
        upstream_error_count_excl_429_529: 1,
        upstream_429_count: 0,
        upstream_529_count: 0,
        error_rate: 1 / 22,
        upstream_error_rate: 1 / 22,
        ttft: { p99_ms: 5019 },
      },
      availability: availableOps,
      concurrency: availableOps,
    });
    const row = result.accounts[0]!;
    expect(row.successRequests).toBe(20);
    expect(row.failureRequests).toBe(1);
    expect(row.scoreableUpstreamErrorRequests).toBe(1);
    expect(row.excludedNonUpstreamErrorRequests).toBe(1);
    expect(row.failoverRequests).toBe(1);
    expect(row.failoverRecovered).toBe(1);
    expect((row.usage as Record<string, unknown>).tokenCount).toBe(2400);
    expect((row.usage as Record<string, unknown>).upstreamCostCny).toBe(0.04);
    expect(result.collection.mode).toBe("native-api-local-aggregation");
  });

  test("does not attribute another group policy event", () => {
    const result = aggregateNativeGroupScore({
      group: { id: 2, name: "pool", platform: "openai", status: "active" },
      accounts: [{ id: 15, name: "primary 0.0", platform: "openai", status: "active", schedulable: true, priority: 1 }],
      usage: [],
      requestErrors: [],
      systemLogs: [{ id: 1, created_at: "2026-07-17T09:00:00Z", message: "openai.forward_failed", request_id: "req-other", account_id: 15, extra: { group_id: 3 } }],
      overview: {},
      availability: {
        status: "available",
        data: {
          group: { "2": { total_accounts: 1, available_count: 0, rate_limit_count: 0, error_count: 1 } },
          account: { "15": { account_id: 15, group_id: 2, is_available: false } },
        },
        reason: null,
      },
      concurrency: { status: "available", data: { group: { "2": { current_in_use: 0, max_capacity: 10, waiting_in_queue: 0 } } }, reason: null },
    });
    expect(result.accounts[0]!.forwardFailedRequests).toBe(0);
    expect(result.accounts[0]!.currentlyAvailable).toBe(false);
    expect(result.group.unavailableAccountCount).toBe(1);
    expect(result.group.maxCapacity).toBe(10);
  });

  test("excludes luna usage, request errors, and system events from scoring", () => {
    const result = aggregateNativeGroupScore({
      group: { id: 2, name: "pool", platform: "openai", status: "active" },
      accounts: [{ id: 15, name: "primary 0.02", platform: "openai", status: "active", schedulable: true, priority: 1 }],
      usage: [
        { id: 1, account_id: 15, group_id: 2, model: "gpt-5.6-terra", stream: true, input_tokens: 10, output_tokens: 5, actual_cost: 0.1, duration_ms: 1000, first_token_ms: 500, created_at: "2026-07-17T09:00:00Z" },
        { id: 2, account_id: 15, group_id: 2, model: "gpt-5.6-luna", stream: true, input_tokens: 100, output_tokens: 50, actual_cost: 1, duration_ms: 9000, first_token_ms: 8000, created_at: "2026-07-17T09:01:00Z" },
      ],
      requestErrors: [
        { id: 1, request_id: "req-terra", account_id: 15, status_code: 502, phase: "upstream", type: "upstream_error", requested_model: "gpt-5.6-terra", message: "temporary failure" },
        { id: 2, request_id: "req-luna", account_id: 15, status_code: 502, phase: "upstream", type: "upstream_error", requested_model: "gpt-5.6-luna", message: "temporary failure" },
      ],
      systemLogs: [
        { id: 1, created_at: "2026-07-17T09:02:00Z", message: "openai.upstream_failover_switching", request_id: "req-terra", account_id: 15, extra: { group_id: 2, requested_model: "gpt-5.6-terra" } },
        { id: 2, created_at: "2026-07-17T09:03:00Z", message: "openai.upstream_failover_switching", request_id: "req-luna", account_id: 15, extra: { group_id: 2, requested_model: "gpt-5.6-luna" } },
      ],
      overview: {},
      availability: availableOps,
      concurrency: availableOps,
    });
    const row = result.accounts[0]!;
    expect(row.successRequests).toBe(1);
    expect(row.failureRequests).toBe(1);
    expect(row.failoverRequests).toBe(1);
    expect((row.usage as Record<string, unknown>).tokenCount).toBe(15);
  });

  test("collects groups sequentially and deduplicates marker results", async () => {
    const calls: string[] = [];
    const fake = {
      async listGroups() {
        calls.push("groups");
        return [
          { id: 2, name: "pool", platform: "openai", status: "active" },
          { id: 3, name: "self", platform: "openai", status: "active" },
        ];
      },
      async listGroupAccounts(groupId: number) { calls.push(`accounts:${groupId}`); return []; },
      async getOpsOverview(groupId: number) { calls.push(`overview:${groupId}`); return {}; },
      async getOpsAccountAvailability(groupId: number) { calls.push(`availability:${groupId}`); return {}; },
      async getOpsConcurrency(groupId: number) { calls.push(`concurrency:${groupId}`); return {}; },
      async listGroupUsage(groupId: number) { calls.push(`usage:${groupId}`); return []; },
      async listRequestErrors(groupId: number) { calls.push(`errors:${groupId}`); return []; },
    } as unknown as Sub2ApiClient;
    const events = {
      async collect() {
        calls.push("events");
        return {
          events: [{ id: 1, created_at: "2026-07-17T09:00:00Z", message: "account_temp_unschedulable", account_id: 15 }],
          evidence: { source: "test", eventCount: 1 },
        };
      },
    };
    const result = await collectNativeScores(fake, events, "8h", new Date("2026-07-17T10:00:00Z"));
    expect(result.groups).toHaveLength(2);
    expect(calls.filter((call) => call === "events")).toHaveLength(1);
    expect(calls.indexOf("accounts:3")).toBeGreaterThan(calls.indexOf("errors:2"));
    const collection = result.collection.groups as Array<Record<string, unknown>>;
    expect(collection[0]!.policyEventRows).toBe(1);
  });
});
