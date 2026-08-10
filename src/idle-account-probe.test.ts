import { expect, test } from "bun:test";
import type { AppConfig } from "./config";
import { IdleAccountProbeService, idleProbeCandidatesSql, idleProbeRequestJitterMs, idleProbeRollingUsageSql } from "./idle-account-probe";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

const config = {
  sub2api: {
    idleProbe: {
      enabled: true, intervalSeconds: 60, idleSeconds: 60, model: "gpt-5.6-terra", reasoningEffort: "low",
      candidateLimit: 20, concurrency: 4, accountTimeoutMs: 15000, roundTimeoutSeconds: 50,
      requestJitterMinMs: 0, requestJitterMaxMs: 0,
      provisionCandidateLimit: 1, provisionTimeoutSeconds: 120,
      isolation: {
        enabled: true,
        gatewayBaseUrl: "https://gateway.example.com/v1",
        groupNamePrefix: "api2business-probe-",
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

test("idle probe selects only normal schedulable API-key accounts", async () => {
  expect(idleProbeCandidatesSql).toContain("LOWER(TRIM(COALESCE(a.type, ''))) <> 'oauth'");
  expect(idleProbeCandidatesSql).toContain("a.status = 'active'");
  expect(idleProbeCandidatesSql).toContain("COALESCE(a.schedulable, false) = true");
  expect(idleProbeCandidatesSql).toContain("FROM usage_logs");
  expect(idleProbeCandidatesSql).toContain("FROM ops_error_logs");
  expect(idleProbeCandidatesSql).toContain("available_sample_count < 100");
  expect(idleProbeCandidatesSql).toContain("insufficient_balance");
  expect(idleProbeCandidatesSql).toContain("o.upstream_error_detail");
  expect(idleProbeCandidatesSql).toContain("$7::boolean OR (");
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "active", schedulable: true, temp_unschedulable_until: null,
    available_sample_count: 4, group_ids: { 0: 2, 1: 3, 2: 51 },
  }]), null);
  const plan = await service.plan();
  expect(plan.databaseQueries).toBe(2);
  expect(plan.candidates).toEqual([{
    accountId: 369, accountName: "upstream plus 0.05", platform: "openai", priority: 300,
    status: "active", schedulable: true, hadRuntimeBlock: false, availableSampleCount: 4,
    groupIds: [2, 3, 51],
  }]);
});

test("idle probe reconciliation repairs a persisted private group removed by a bulk account update", async () => {
  const ensured: number[] = [];
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    ensure: async (accountId: number) => {
      ensured.push(accountId);
      return { accountId, groupId: 51, keyCreated: false };
    },
  };
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "active", schedulable: true, available_sample_count: 4, group_ids: [2, 3],
  }]), null, isolation as never);

  expect(await service.reconcile()).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
  expect(ensured).toEqual([369]);
});

test("idle probe reconciliation skips a persisted binding still present in the database", async () => {
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    ensure: async () => { throw new Error("must not reconcile an intact binding"); },
  };
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "active", schedulable: true, available_sample_count: 4, group_ids: [2, 3, 51],
  }]), null, isolation as never);

  expect(await service.reconcile()).toMatchObject({ attempted: 0, succeeded: 0, failed: 0 });
});

test("explicit manual reconciliation is not truncated by the automatic provision limit", async () => {
  const ensured: number[] = [];
  const isolation = {
    get: () => null,
    ensure: async (accountId: number) => {
      ensured.push(accountId);
      return { accountId, groupId: accountId + 100, keyCreated: true };
    },
  };
  const service = new IdleAccountProbeService(config, reads([
    {
      account_id: 28, account_name: "upstream-28", platform: "openai", priority: 300,
      account_status: "active", schedulable: true, available_sample_count: 4, group_ids: [2, 3],
    },
    {
      account_id: 29, account_name: "upstream-29", platform: "openai", priority: 300,
      account_status: "active", schedulable: true, available_sample_count: 4, group_ids: [2, 3],
    },
  ]), null, isolation as never);

  expect(await service.reconcile([28, 29])).toMatchObject({ attempted: 2, succeeded: 2, failed: 0 });
  expect(ensured).toEqual([28, 29]);
});

test("explicit manual reconciliation includes an error OpenAI API-key account", async () => {
  const ensured: number[] = [];
  const isolation = {
    get: () => null,
    ensure: async (accountId: number) => {
      ensured.push(accountId);
      return { accountId, groupId: 146, keyCreated: true };
    },
  };
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 46, account_name: "upstream-46", platform: "openai", priority: 300,
    account_status: "error", schedulable: false, available_sample_count: 4, group_ids: [2, 3],
  }]), null, isolation as never);

  expect(await service.reconcile([46])).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
  expect(ensured).toEqual([46]);
});

test("idle probe usage follows monitor-user owned API keys", () => {
  expect(idleProbeRollingUsageSql).toContain("owner.email = 'monitor-user@sub2api.platform-infra.local'");
  expect(idleProbeRollingUsageSql).toContain("JOIN probe_keys p ON p.id = u.api_key_id");
  expect(idleProbeRollingUsageSql).toContain("JOIN probe_keys p ON p.id = o.api_key_id");
});

test("automatic idle probe planning uses one queued database query", async () => {
  let queries = 0;
  const client = reads([]);
  const query = client.query.bind(client);
  client.query = async (request) => {
    queries += 1;
    return await query(request);
  };
  const service = new IdleAccountProbeService(config, client, null);

  expect(await service.plan([], "automatic")).toMatchObject({
    databaseQueries: 1,
    rolling24Hours: null,
  });
  expect(queries).toBe(1);
});

test("idle probe request jitter includes both configured boundaries", () => {
  expect(idleProbeRequestJitterMs(1000, 3000, () => 0)).toBe(1000);
  expect(idleProbeRequestJitterMs(1000, 3000, () => 0.999999)).toBe(3000);
});

test("idle probe skips a concurrent round and never retries inside one account attempt", async () => {
  let calls = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    probe: async () => { calls += 1; await gate; return { classification: "alive", ordinaryLogRecorded: true }; },
  };
  const runtime = {};
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "active", schedulable: true, group_ids: [51],
  }]), runtime as never, isolation as never);
  const first = service.run([369], 1);
  await Bun.sleep(1);
  expect(await service.run([369], 1)).toMatchObject({ skipped: true, reason: "in-flight" });
  release();
  expect(await first).toMatchObject({
    planned: 1,
    ready: 1,
    unreadyAccountIds: [],
    attempted: 1,
    succeeded: 1,
    failed: 0,
    evidence: "isolated-user-api-key-responses-request",
    ordinaryLogRecorded: true,
  });
  expect(calls).toBe(1);
});

test("idle probe does not claim an ordinary log when the gateway never responds", async () => {
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    probe: async () => ({ classification: "error", ordinaryLogRecorded: false, errorMarker: "request-timeout" }),
  };
  const runtime = { recoverAccounts: async () => {} };
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "active", schedulable: true, group_ids: [51],
  }]), runtime as never, isolation as never);

  expect(await service.run([369], 1)).toMatchObject({
    ok: false,
    attempted: 1,
    succeeded: 0,
    failed: 1,
    ordinaryLogRecorded: false,
  });
});

test("idle probe does not use a persisted key after its private group binding was removed", async () => {
  let probes = 0;
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    probe: async () => {
      probes += 1;
      return { classification: "alive", ordinaryLogRecorded: true };
    },
  };
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "active", schedulable: true, group_ids: [2],
  }]), {} as never, isolation as never);

  expect(await service.run([369], 1)).toMatchObject({
    ok: true,
    attempted: 0,
    ready: 0,
    unreadyAccountIds: [369],
    ordinaryLogRecorded: false,
  });
  expect(probes).toBe(0);
});

test("idle probe skips blocked accounts even when an explicit plan is stale", async () => {
  let probes = 0;
  const runtime = {};
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    probe: async () => { probes += 1; return { classification: "alive", ordinaryLogRecorded: true }; },
  };
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "error", schedulable: false,
  }]), runtime as never, isolation as never);

  expect(await service.run([369], 1)).toMatchObject({
    ok: true,
    attempted: 0,
    planned: 1,
    ready: 0,
    unreadyAccountIds: [369],
  });
  expect(probes).toBe(0);
});

test("idle probe sends every ready planned request concurrently", async () => {
  let active = 0;
  let peak = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rows = Array.from({ length: 8 }, (_, index) => ({
    account_id: index + 1, account_name: `upstream-${index + 1}`, platform: "openai", priority: 300,
    account_status: "active", schedulable: true, group_ids: [index + 101],
  }));
  const runtime = { recoverAccounts: async () => {} };
  const isolation = {
    get: (accountId: number) => ({ accountId, groupId: accountId + 100, keyCreated: false }),
    probe: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return { classification: "alive", ordinaryLogRecorded: true };
    },
  };
  const service = new IdleAccountProbeService(config, reads(rows), runtime as never, isolation as never);
  const running = service.run([], 1);
  await Bun.sleep(5);
  expect(peak).toBe(8);
  release();
  expect(await running).toMatchObject({ attempted: 8, succeeded: 8, probeConcurrency: "all-ready-candidates" });
});
