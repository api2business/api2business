import { expect, test } from "bun:test";
import type { AppConfig } from "./config";
import { IdleAccountProbeService, idleProbeCandidatesSql } from "./idle-account-probe";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

const config = {
  sub2api: {
    idleProbe: {
      enabled: true, intervalSeconds: 60, idleSeconds: 60, model: "gpt-5.5",
      candidateLimit: 20, concurrency: 4, accountTimeoutMs: 15000, roundTimeoutSeconds: 50,
      isolation: {
        enabled: true,
        gatewayBaseUrl: "https://api.example.com/v1",
        groupNamePrefix: "apistate-probe-",
        groupRateMultiplier: 0,
        userBalance: 0.01,
        secretFile: ".state/idle-probe/probe-keys.json",
      },
    },
    priorityPlan: { platform: "openai", eligibleGroupIds: [2, 3] },
  },
} as AppConfig;

function reads(rows: Array<Record<string, unknown>>): Sub2ApiReadClient {
  return {
    query: async <Row extends Record<string, unknown>>() => ({
      rows: rows as Row[], queueDurationMs: 0, queryDurationMs: 1, totalDurationMs: 1,
      queryStartedAt: new Date().toISOString(), queryCompletedAt: new Date().toISOString(),
      deduplicated: false, cached: false,
    }),
    status: () => ({}) as ReturnType<Sub2ApiReadClient["status"]>,
  };
}

test("idle probe selects only ordinary-log-idle schedulable API-key accounts", async () => {
  expect(idleProbeCandidatesSql).toContain("LOWER(TRIM(COALESCE(a.type, ''))) <> 'oauth'");
  expect(idleProbeCandidatesSql).toContain("FROM usage_logs");
  expect(idleProbeCandidatesSql).toContain("FROM ops_error_logs");
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
  }]), null);
  const plan = await service.plan();
  expect(plan.databaseQueries).toBe(1);
  expect(plan.candidates).toEqual([{
    accountId: 369, accountName: "upstream plus 0.05", platform: "openai", priority: 300,
  }]);
});

test("idle probe skips a concurrent round and never retries inside one account attempt", async () => {
  let calls = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const isolation = {
    probe: async () => { calls += 1; await gate; return { classification: "alive", ordinaryLogRecorded: true }; },
  };
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
  }]), null, isolation as never);
  const first = service.run([369], 1);
  await Bun.sleep(1);
  expect(await service.run([369], 1)).toMatchObject({ skipped: true, reason: "in-flight" });
  release();
  expect(await first).toMatchObject({
    attempted: 1,
    succeeded: 1,
    failed: 0,
    evidence: "isolated-user-api-key-responses-request",
    ordinaryLogRecorded: true,
  });
  expect(calls).toBe(1);
});
