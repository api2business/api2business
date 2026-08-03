import { expect, test } from "bun:test";
import type { AppConfig } from "./config";
import { IdleAccountProbeService, idleProbeCandidatesSql, idleProbeRollingUsageSql } from "./idle-account-probe";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

const config = {
  sub2api: {
    idleProbe: {
      enabled: true, intervalSeconds: 60, idleSeconds: 60, model: "gpt-5.5",
      candidateLimit: 20, concurrency: 4, accountTimeoutMs: 15000, roundTimeoutSeconds: 50,
      provisionCandidateLimit: 1, provisionTimeoutSeconds: 120,
      isolation: {
        enabled: true,
        gatewayBaseUrl: "https://api.example.com/v1",
        groupNamePrefix: "apistate-probe-",
        groupRateMultiplier: 1,
        userBalance: 100,
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

test("idle probe selects ordinary-log-idle API-key accounts regardless of runtime state", async () => {
  expect(idleProbeCandidatesSql).toContain("LOWER(TRIM(COALESCE(a.type, ''))) <> 'oauth'");
  expect(idleProbeCandidatesSql).not.toContain("a.status = 'active'");
  expect(idleProbeCandidatesSql).not.toContain("a.schedulable = true");
  expect(idleProbeCandidatesSql).toContain("FROM usage_logs");
  expect(idleProbeCandidatesSql).toContain("FROM ops_error_logs");
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "error", schedulable: false, temp_unschedulable_until: "2026-08-04T08:00:00Z",
  }]), null);
  const plan = await service.plan();
  expect(plan.databaseQueries).toBe(2);
  expect(plan.candidates).toEqual([{
    accountId: 369, accountName: "upstream plus 0.05", platform: "openai", priority: 300,
    status: "error", schedulable: false, hadRuntimeBlock: true,
  }]);
});

test("idle probe usage follows monitor-user owned API keys", () => {
  expect(idleProbeRollingUsageSql).toContain("owner.email = 'monitor-user@sub2api.platform-infra.local'");
  expect(idleProbeRollingUsageSql).toContain("JOIN probe_keys p ON p.id = u.api_key_id");
  expect(idleProbeRollingUsageSql).toContain("JOIN probe_keys p ON p.id = o.api_key_id");
});

test("idle probe skips a concurrent round and never retries inside one account attempt", async () => {
  let calls = 0;
  const recoveryPlans: number[][] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    probe: async () => { calls += 1; await gate; return { classification: "alive", ordinaryLogRecorded: true }; },
  };
  const runtime = { recoverAccounts: async (accountIds: number[]) => { recoveryPlans.push(accountIds); } };
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "error", schedulable: false,
  }]), runtime as never, isolation as never);
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
  expect(recoveryPlans).toEqual([[369]]);
});

test("idle probe does not claim an ordinary log when the gateway never responds", async () => {
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    probe: async () => ({ classification: "error", ordinaryLogRecorded: false, errorMarker: "request-timeout" }),
  };
  const runtime = { recoverAccounts: async () => {} };
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "active", schedulable: true,
  }]), runtime as never, isolation as never);

  expect(await service.run([369], 1)).toMatchObject({
    ok: false,
    attempted: 1,
    succeeded: 0,
    failed: 1,
    ordinaryLogRecorded: false,
  });
});

test("idle probe does not send requests when planned bulk recovery fails", async () => {
  let probes = 0;
  const runtime = { recoverAccounts: async () => { throw new Error("restore failed"); } };
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    probe: async () => { probes += 1; return { classification: "alive", ordinaryLogRecorded: true }; },
  };
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "error", schedulable: false,
  }]), runtime as never, isolation as never);

  expect(await service.run([369], 1)).toMatchObject({
    ok: false,
    attempted: 0,
    bulkRecoveryFailures: 1,
    results: [{ skipped: true, reason: "bulk-recovery-failed", accountIds: [369], error: "restore failed" }],
  });
  expect(probes).toBe(0);
});
