import { expect, test } from "bun:test";
import { inspectAccounts, recoveryConfigFromInspection, verifyImportedAccounts, verifyRecoveredOAuthConfig } from "./account-inspection";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";

function reads(rows: Array<Record<string, unknown>>): Sub2ApiReadClient {
  return { query: async () => ({
    rows, queueDurationMs: 2, queryDurationMs: 3, totalDurationMs: 5,
    queryStartedAt: "2026-01-01T00:00:00Z", queryCompletedAt: "2026-01-01T00:00:01Z",
    deduplicated: false, cached: false,
  }) } as unknown as Sub2ApiReadClient;
}

test("inspects only runtime fields without credentials", async () => {
  const result = await inspectAccounts([99], reads([{
    id: 99, name: "account", platform: "openai", type: "oauth", status: "active", schedulable: true,
    priority: 1, capacity: 5, load_factor: 1000, rate_multiplier: 1, auto_pause_on_expired: true, proxy_id: 8, proxy_name: "pool-8", proxy_status: "active",
    group_ids: [2, 3], group_names: ["pool", "self"], plan_type: "k12", credentials: { access_token: "secret" },
  }]));
  expect(result.accounts).toEqual([{
    id: 99, name: "account", platform: "openai", type: "oauth", status: "active", schedulable: true,
    priority: 1, capacity: 5, loadFactor: 1000, rateMultiplier: 1, autoPauseOnExpired: true, planType: "k12", proxyId: 8, proxyName: "pool-8", proxyStatus: "active",
    groupIds: [2, 3], groupNames: ["pool", "self"],
  }]);
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("captures and strictly verifies a recovered OAuth runtime configuration", () => {
  const original = {
    id: 1473, platform: "openai", type: "oauth", status: "error", schedulable: false, priority: 1, capacity: 16,
    loadFactor: 1000, rateMultiplier: 1, autoPauseOnExpired: true, proxyId: null, groupIds: [2, 3],
  };
  const expected = recoveryConfigFromInspection({ accounts: [original] }, 1473);
  expect(verifyRecoveredOAuthConfig({ accounts: [{ ...original, id: 1476, proxyId: 0 }] }, [1476], expected)).toMatchObject({ ok: true, aligned: 1 });
  expect(verifyRecoveredOAuthConfig({ accounts: [{ ...original, id: 1476, capacity: 3, proxyId: 0 }] }, [1476], expected))
    .toMatchObject({ ok: false, accounts: [expect.objectContaining({ reasons: ["capacity"] })] });
});

test("reports an unbound imported account as misaligned", async () => {
  const result = await verifyImportedAccounts([99], { priority: 1, capacity: 5, groupIds: [2, 3], planType: "k12" }, [3, 8], reads([{
    id: 99, name: "account", platform: "openai", type: "oauth", status: "active", schedulable: true,
    priority: 1, capacity: 5, proxy_id: null, proxy_name: "", proxy_status: "",
    group_ids: [2, 3], group_names: ["pool", "self"], plan_type: "k12",
  }]));
  expect(result.ok).toBe(false);
  expect((result.accounts as Array<Record<string, unknown>>)[0]?.reasons).toEqual(["proxy-unbound"]);
});
