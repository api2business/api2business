import { expect, test } from "bun:test";
import type { AppConfig } from "./config";
import { IdleAccountProbeService, idleProbeCandidatesSql, idleProbeRequestJitterMs, idleProbeRollingUsageSql, PROBE_COMPACT_CACHE_MIN_KNOWN_SAMPLES, selectIdleProbeModel, selectProbeCacheMode } from "./idle-account-probe";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

const config = {
  sub2api: {
    idleProbe: {
      enabled: true, intervalSeconds: 60, idleSeconds: 60, model: "gpt-6.1-sol", reasoningEffort: "low",
      candidateLimit: 20, concurrency: 4, accountTimeoutMs: 120000, roundTimeoutSeconds: 300,
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
} as unknown as AppConfig;

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
  expect(idleProbeCandidatesSql).toContain("JOIN usage_logs");
  expect(idleProbeCandidatesSql).toContain("JOIN ops_error_logs");
  expect(idleProbeCandidatesSql).toContain("WITH target_accounts AS MATERIALIZED");
  expect(idleProbeCandidatesSql).toContain("probe_groups AS");
  expect(idleProbeCandidatesSql).toContain("recent_activity AS");
  expect(idleProbeCandidatesSql).not.toContain("CROSS JOIN LATERAL");
  expect(idleProbeCandidatesSql).toContain("available_sample_count");
  expect(idleProbeCandidatesSql).toContain("insufficient_balance");
  expect(idleProbeCandidatesSql).toContain("upstream_error_detail");
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
    groupIds: [2, 3, 51], probeModel: "gpt-6.1-sol",
    probeCacheKnownSamples: 0, probeCacheHitSamples: 0, probeCachePlatformHitSamples: 0,
    probeCacheMode: "compact",
  }]);
});

test("idle probe prefers gpt-6.1-sol, then Terra, from the account model whitelist", () => {
  expect(selectIdleProbeModel(["gpt-5.6-terra", "gpt-6.1-sol"], "gpt-6.1-sol")).toBe("gpt-6.1-sol");
  expect(selectIdleProbeModel(["gpt-5.6-sol", "gpt-5.5"], "gpt-5.6-terra")).toBe("gpt-5.6-sol");
  expect(selectIdleProbeModel(["gpt-5.6-terra", "gpt-5.6-sol"], "gpt-5.6-terra")).toBe("gpt-5.6-terra");
  expect(selectIdleProbeModel(["gpt-5.5"], "gpt-5.6-terra")).toBe("gpt-5.5");
  expect(selectIdleProbeModel([], "gpt-5.6-terra")).toBe("gpt-5.6-terra");
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
  expect(idleProbeRollingUsageSql).toContain("monitor_account.balance AS monitor_balance_usd");
  expect(idleProbeRollingUsageSql).toContain("NOW() AS monitor_balance_queried_at");
});

test("idle probe summary exposes only normalized monitor balance state", async () => {
  const service = new IdleAccountProbeService(config, reads([{
    success_requests: 8,
    error_requests: 2,
    sampled_accounts: 3,
    consumed_api_amount_usd: "0.125",
    first_sample_at: "2026-09-19T09:00:00.000Z",
    latest_sample_at: "2026-09-19T10:00:00.000Z",
    monitor_balance_usd: "1.75",
    monitor_balance_queried_at: "2026-09-19T10:00:01.000Z",
  }]), null);

  expect(await service.summary()).toEqual({
    rolling24Hours: {
      windowHours: 24,
      successRequests: 8,
      errorRequests: 2,
      requestAttempts: 10,
      sampledAccounts: 3,
      consumedApiAmountUsd: 0.125,
      firstSampleAt: "2026-09-19T09:00:00.000Z",
      latestSampleAt: "2026-09-19T10:00:00.000Z",
      source: "ordinary-usage-logs-probe-users",
    },
    monitorAccount: {
      balanceUsd: 1.75,
      status: "available",
      queriedAt: "2026-09-19T10:00:01.000Z",
    },
  });
});

test("idle probe summary marks zero balance depleted and invalid balance unknown", async () => {
  const depleted = new IdleAccountProbeService(config, reads([{ monitor_balance_usd: "0" }]), null);
  expect((await depleted.summary()).monitorAccount).toMatchObject({ balanceUsd: 0, status: "depleted" });

  const unknown = new IdleAccountProbeService(config, reads([{ monitor_balance_usd: "not-a-number" }]), null);
  expect((await unknown.summary()).monitorAccount).toMatchObject({ balanceUsd: null, status: "unknown" });
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

test("idle probe skips a concurrent round and uses the full per-account timeout", async () => {
  let calls = 0;
  let observedTimeoutMs = 0;
  let release = () => {};
  let markStarted = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    probe: async (_accountId: number, _model: string, timeoutMs: number) => {
      calls += 1;
      observedTimeoutMs = timeoutMs;
      markStarted();
      await gate;
      return { classification: "alive", ordinaryLogRecorded: true, qualityOk: true };
    },
  };
  const runtime = {};
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "active", schedulable: true, group_ids: [51],
  }]), runtime as never, isolation as never);
  const first = service.run([369], 1);
  await started;
  expect(await service.run([369], 1)).toMatchObject({ skipped: true, reason: "in-flight" });
  release();
  expect(observedTimeoutMs).toBe(120000);
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

test("idle probe keeps concurrent rounds independent across scheduling scopes", async () => {
  let calls = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const isolation = {
    get: (accountId: number) => ({ accountId, groupId: 51, keyCreated: false }),
    probe: async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { classification: "alive", ordinaryLogRecorded: true, qualityOk: true };
    },
  };
  const scopedConfig = {
    ...config,
    operations: {
      upstreamSchedulingV2: {
        enabled: true,
        scopes: {
          codex: { enabled: true, platform: "openai", eligibleGroupIds: [2], features: { idleProbe: true } },
          claude: { enabled: true, platform: "openai", eligibleGroupIds: [2], features: { idleProbe: true } },
        },
      },
    },
  } as unknown as AppConfig;
  const service = new IdleAccountProbeService(scopedConfig, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "active", schedulable: true, group_ids: [51],
  }]), {} as never, isolation as never);

  const first = service.run([369], 1, "codex");
  await Bun.sleep(1);
  const second = service.run([369], 1, "claude");
  expect(await second).toMatchObject({ skipped: false, attempted: 1, succeeded: 1 });
  release();
  expect(await first).toMatchObject({ skipped: false, attempted: 1, succeeded: 1 });
});

test("idle probe reconciles the monitor wallet before a round", async () => {
  let balanceChecks = 0;
  const isolation = {
    ensureMonitorBalance: async () => {
      balanceChecks += 1;
      return { userId: 61, balanceUsd: 100, targetBalanceUsd: 100, replenished: true, observedAt: new Date().toISOString() };
    },
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    probe: async () => ({ classification: "alive", ordinaryLogRecorded: true, qualityOk: true }),
  };
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "active", schedulable: true, group_ids: [51],
  }]), {} as never, isolation as never);

  expect(await service.run([369], 1)).toMatchObject({
    ok: true,
    monitorBalance: { userId: 61, balanceUsd: 100, replenished: true },
  });
  expect(balanceChecks).toBe(1);
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

test("idle probe repairs a removed private group binding before probing", async () => {
  let probes = 0;
  let ensures = 0;
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    ensure: async (accountId: number) => {
      ensures += 1;
      return { accountId, groupId: 51, keyCreated: false };
    },
    probe: async () => {
      probes += 1;
      return { classification: "alive", ordinaryLogRecorded: true, qualityOk: true };
    },
  };
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "active", schedulable: true, group_ids: [2],
  }]), {} as never, isolation as never);

  expect(await service.run([369], 1)).toMatchObject({
    ok: true,
    attempted: 1,
    succeeded: 1,
    ready: 1,
    repairedAccountIds: [369],
    repairFailures: [],
    unreadyAccountIds: [],
    ordinaryLogRecorded: true,
  });
  expect(ensures).toBe(1);
  expect(probes).toBe(1);
});

test("idle probe exposes a binding repair failure instead of only marking it unready", async () => {
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    ensure: async () => { throw new Error("探活隔离账号绑定阶段失败：write timeout sk-secret-value"); },
    probe: async () => ({ classification: "alive", ordinaryLogRecorded: true, qualityOk: true }),
  };
  const service = new IdleAccountProbeService(config, reads([{
    account_id: 369, account_name: "upstream plus 0.05", platform: "openai", priority: 300,
    account_status: "active", schedulable: true, group_ids: [2],
  }]), {} as never, isolation as never);

  expect(await service.run([369], 1)).toMatchObject({
    ok: false,
    attempted: 0,
    ready: 0,
    repairedAccountIds: [],
    repairFailures: [{ accountId: 369, error: "探活隔离账号绑定阶段失败：write timeout [REDACTED]" }],
    unreadyAccountIds: [369],
  });
});

test("idle probe reports exhausted binding repair budget for every remaining account", async () => {
  const ensured: number[] = [];
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    ensure: async (accountId: number) => {
      ensured.push(accountId);
      return { accountId, groupId: 51, keyCreated: false };
    },
    probe: async () => ({ classification: "alive", ordinaryLogRecorded: true, qualityOk: true }),
  };
  const service = new IdleAccountProbeService(config, reads([369, 370].map((accountId) => ({
    account_id: accountId, account_name: `upstream-${accountId}`, platform: "openai", priority: 300,
    account_status: "active", schedulable: true, group_ids: [2],
  }))), {} as never, isolation as never);

  expect(await service.run([369, 370], 1)).toMatchObject({
    ok: false,
    ready: 1,
    repairedAccountIds: [369],
    repairFailures: [{ accountId: 370, error: "probe isolation repair budget exhausted" }],
    unreadyAccountIds: [370],
  });
  expect(ensured).toEqual([369]);
});

test("idle probe skips blocked accounts even when an explicit plan is stale", async () => {
  let probes = 0;
  const runtime = {};
  const isolation = {
    get: () => ({ accountId: 369, groupId: 51, keyCreated: false }),
    probe: async () => { probes += 1; return { classification: "alive", ordinaryLogRecorded: true, qualityOk: true }; },
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
      return { classification: "alive", ordinaryLogRecorded: true, qualityOk: true };
    },
  };
  const service = new IdleAccountProbeService(config, reads(rows), runtime as never, isolation as never);
  const running = service.run([], 1);
  for (let waitedMs = 0; waitedMs < 100 && peak < 8; waitedMs += 5) await Bun.sleep(5);
  expect(peak).toBe(8);
  release();
  expect(await running).toMatchObject({ attempted: 8, succeeded: 8, probeConcurrency: "all-ready-candidates" });
});

test("cache mode uses platform evidence without sacrificing an observed hit", () => {
  expect(PROBE_COMPACT_CACHE_MIN_KNOWN_SAMPLES).toBe(20);
  expect(selectProbeCacheMode(0, 0, 0)).toBe("compact");
  expect(selectProbeCacheMode(19, 0, 0)).toBe("compact");
  expect(selectProbeCacheMode(20, 0, 0)).toBe("compact");
  expect(selectProbeCacheMode(0, 0, 5)).toBe("full");
  expect(selectProbeCacheMode(19, 0, 5)).toBe("full");
  expect(selectProbeCacheMode(20, 0, 5)).toBe("compact");
  expect(selectProbeCacheMode(20, 1, 5)).toBe("full");
  expect(selectProbeCacheMode(327, 255, 255)).toBe("full");
  expect(selectProbeCacheMode(Number.NaN, 0, 0)).toBe("compact");
});

test("cache evidence SQL is account-scoped, 24 hours, and counts only explicit cache fields", () => {
  expect(idleProbeCandidatesSql).toContain("cache_known_samples");
  expect(idleProbeCandidatesSql).toContain("cache_hit_samples");
  expect(idleProbeCandidatesSql).toContain("COUNT(*) FILTER (WHERE u.cache_read_tokens IS NOT NULL)");
  expect(idleProbeCandidatesSql).toContain("COUNT(*) FILTER (WHERE u.cache_read_tokens > 0)");
  expect(idleProbeCandidatesSql).toContain("u.created_at >= NOW() - INTERVAL '24 hours'");
  expect(idleProbeCandidatesSql).toContain("platform_cache_hit_samples");
  expect(idleProbeCandidatesSql).not.toContain("cache_read_tokens IS NULL AS");
});

test("compact cache mode is applied only to the planned candidate and stays visible in evidence", async () => {
  const rows = [
    { account_id: 1, account_name: "cached", platform: "anthropic", priority: 300, account_status: "active",
      schedulable: true, group_ids: [101], cache_known_samples: 300, cache_hit_samples: 240,
      platform_cache_hit_samples: 240 },
    { account_id: 2, account_name: "never-cached", platform: "anthropic", priority: 300, account_status: "active",
      schedulable: true, group_ids: [102], cache_known_samples: 320, cache_hit_samples: 0,
      platform_cache_hit_samples: 240 },
    { account_id: 3, account_name: "unknown-cache", platform: "anthropic", priority: 300, account_status: "active",
      schedulable: true, group_ids: [103], cache_known_samples: 0, cache_hit_samples: 0,
      platform_cache_hit_samples: 240 },
  ];
  const modes: Array<{ accountId: number; mode: string | undefined }> = [];
  const isolation = {
    get: (accountId: number) => ({ accountId, groupId: accountId + 100, keyCreated: false }),
    probe: async (accountId: number, _model: string, _timeout: number, _reasoning: string, mode: string) => {
      modes.push({ accountId, mode });
      return { classification: "alive", ordinaryLogRecorded: true, qualityOk: true, cacheMode: mode };
    },
  };
  const service = new IdleAccountProbeService(config, reads(rows), { recoverAccounts: async () => {} } as never, isolation as never);
  const result = await service.run([], 1);
  expect(result).toMatchObject({ attempted: 3, succeeded: 3 });
  expect(modes.sort((left, right) => left.accountId - right.accountId))
    .toEqual([{ accountId: 1, mode: "full" }, { accountId: 2, mode: "compact" }, { accountId: 3, mode: "full" }]);
  const candidates = (result.results as Array<Record<string, unknown>>);
  expect(candidates.every((item) => item.response
    && typeof item.response === "object")).toBe(true);
});
