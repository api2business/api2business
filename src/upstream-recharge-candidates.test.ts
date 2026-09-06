import { expect, test } from "bun:test";
import { collectRechargeCandidates, lowWalletRows, rechargeCandidatesQuery } from "./upstream-recharge-candidates";
import type { AppConfig } from "./config";

test("低余额候选严格使用人民币小于阈值，并展开共享 wallet 的账号", () => {
  const rows = lowWalletRows([
    { wallet_key: "https://a.example", sampled_at: "2026-08-09T00:00:00Z", probe_ok: true, remaining_cny: 9.99, account_id: 11, account_cost_inputs: [{ accountId: 12 }] },
    { wallet_key: "https://a.example", sampled_at: "2026-08-09T00:05:00Z", probe_ok: true, remaining_cny: 9.5, account_id: 11, account_cost_inputs: [{ accountId: 12 }, { accountId: 13 }] },
    { wallet_key: "https://equal.example", sampled_at: "2026-08-09T00:05:00Z", probe_ok: true, remaining_cny: 10, account_id: 14, account_cost_inputs: [] },
    { wallet_key: "https://unknown.example", sampled_at: "2026-08-09T00:05:00Z", probe_ok: false, remaining_cny: 1, account_id: 15, account_cost_inputs: [] },
  ], 10, 24);
  expect(rows.map((row) => row.account_id).sort()).toEqual([11, 12, 13]);
  expect(rows.every((row) => row.balance_cny < 10 && row.lookbackHours === 24)).toBe(true);
});

test("充值候选历史 SQL 保留欠费前窗口和业务错误排除口径", () => {
  expect(rechargeCandidatesQuery).toContain("o.created_at < c.anchor_at");
  expect(rechargeCandidatesQuery).toContain("c.anchor_at - ($3::int * INTERVAL '1 hour')");
  expect(rechargeCandidatesQuery).toContain("monitor-user@sub2api.platform-infra.local");
  expect(rechargeCandidatesQuery).toContain("%luna%");
  expect(rechargeCandidatesQuery).toContain("%model_not_found%");
  expect(rechargeCandidatesQuery).toContain("failover_event");
  expect(rechargeCandidatesQuery).toContain("/responses/compact");
  expect(rechargeCandidatesQuery).toContain("jsonb_array_elements_text(");
  expect(rechargeCandidatesQuery).toContain("jsonb_typeof($1::jsonb)='array'");
});

test("充值候选只读取一次 Sub2API，并返回低余额账号的 24 小时表现", async () => {
  let queryCount = 0;
  const config = {
    operations: {
      upstreamManagement: { rechargeCandidates: { lowBalanceCny: 10, lookbackHours: 24, recommendationLimit: 20, retiredSuppliers: [] } },
    },
    sub2api: {
      scorePolicy: { reliabilityWeight: 45, failoverWeight: 10, latencyWeight: 35, baselineWeight: 10, failureZeroScoreRate: 0.2, failureBurstCallLimit: 100, failoverZeroScoreRate: 0.2, ttftFullScoreMs: 5000, ttftZeroScoreMs: 55000, ttftPriorScore: 25 },
      grokScorePolicy: { reliabilityWeight: 45, failoverWeight: 10, latencyWeight: 35, baselineWeight: 10, failureZeroScoreRate: 0.2, failureBurstCallLimit: 100, failoverZeroScoreRate: 0.2, ttftFullScoreMs: 5000, ttftZeroScoreMs: 55000, ttftPriorScore: 25 },
      priorityPlan: { procurementAdvice: { billingErrorPatterns: ["insufficient balance"] } },
      grokPriorityPlan: { procurementAdvice: { billingErrorPatterns: ["balance depleted"] } },
    },
  } as unknown as AppConfig;
  const store = {
    async getLatestSuccessfulUpstreamQuotaSamples() {
      return [{ wallet_key: "https://low.example", sampled_at: "2026-08-09T01:00:00Z", probe_ok: true, remaining_cny: 4, account_id: 21, account_cost_inputs: [] }];
    },
  };
  const reads = {
    async query() {
      queryCount += 1;
      return { rows: [{ account_id: 21, account_name: "https://low.example 0.05", platform: "openai", account_type: "apikey", status: "active", schedulable: true, balance_cny: 4, wallet_key: "https://low.example", primary_reason: "low-balance", anchor_at: "2026-08-09T01:00:00Z", success_requests: 20, failure_requests: 0, attributed_requests: 20, stream_success_requests: 20, first_token_samples: 20, ttft_values: [1000], ttft_weights: [1], duration_values: [1000], duration_weights: [1], api_amount_usd: 2, selected_calls: 20 }], queueDurationMs: 1, queryDurationMs: 2, totalDurationMs: 3, queryStartedAt: "", queryCompletedAt: "", deduplicated: false, cached: false };
    },
  };
  const result = await collectRechargeCandidates(config, store as never, reads as never);
  expect(queryCount).toBe(1);
  expect(result.candidates).toHaveLength(1);
  expect((result.candidates as Array<Record<string, unknown>>)[0]).toMatchObject({
    accountId: 21, balanceCny: 4, reason: "low-balance", recommendation: "recharge-priority",
    anchorAt: "2026-08-09T01:00:00.000Z",
  });
  expect((result.candidates as Array<Record<string, unknown>>)[0]?.recommendationScore).toBeGreaterThan(50);
});

test("退场供应商保留审计结果但永不进入充值推荐", async () => {
  const config = {
    operations: {
      upstreamManagement: { rechargeCandidates: { lowBalanceCny: 10, lookbackHours: 24, recommendationLimit: 20, retiredSuppliers: ["xianapi.cloud"] } },
    },
    sub2api: {
      scorePolicy: { reliabilityWeight: 45, failoverWeight: 10, latencyWeight: 35, baselineWeight: 10, failureZeroScoreRate: 0.2, failureBurstCallLimit: 100, failoverZeroScoreRate: 0.2, ttftFullScoreMs: 5000, ttftZeroScoreMs: 55000, ttftPriorScore: 25 },
      grokScorePolicy: { reliabilityWeight: 45, failoverWeight: 10, latencyWeight: 35, baselineWeight: 10, failureZeroScoreRate: 0.2, failureBurstCallLimit: 100, failoverZeroScoreRate: 0.2, ttftFullScoreMs: 5000, ttftZeroScoreMs: 55000, ttftPriorScore: 25 },
      priorityPlan: { procurementAdvice: { billingErrorPatterns: ["insufficient balance"] } },
      grokPriorityPlan: { procurementAdvice: { billingErrorPatterns: ["balance depleted"] } },
    },
  } as unknown as AppConfig;
  const store = {
    async getLatestSuccessfulUpstreamQuotaSamples() { return []; },
  };
  const reads = {
    async query() {
      return { rows: [{ account_id: 66, account_name: "https://www.xianapi.cloud plus 0.08", base_url: "https://www.xianapi.cloud", platform: "openai", account_type: "apikey", status: "error", schedulable: false, primary_reason: "billing-depleted", anchor_at: "2026-08-09T01:00:00Z", success_requests: 100, failure_requests: 0, attributed_requests: 100, stream_success_requests: 100, first_token_samples: 100, ttft_values: [1000], ttft_weights: [1], duration_values: [1000], duration_weights: [1], api_amount_usd: 10, selected_calls: 100 }], queueDurationMs: 1, queryDurationMs: 2, totalDurationMs: 3, queryStartedAt: "", queryCompletedAt: "", deduplicated: false, cached: false };
    },
  };
  const result = await collectRechargeCandidates(config, store as never, reads as never);
  expect(result.recommendedCount).toBe(0);
  expect(result.retiredSupplierCount).toBe(1);
  expect((result.candidates as Array<Record<string, unknown>>)[0]).toMatchObject({
    accountId: 66,
    supplier: "xianapi.cloud",
    supplierLifecycle: "retired",
    recommendation: "supplier-retired",
  });
});
