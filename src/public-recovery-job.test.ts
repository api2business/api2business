import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, HttpCliTarget } from "./config";
import { PublicRecoveryJobManager } from "./public-recovery-job";

const originalAccount = {
  id: 1473, platform: "openai", type: "oauth", status: "error", schedulable: false,
  priority: 1, capacity: 16, loadFactor: 1000, rateMultiplier: 1, autoPauseOnExpired: true,
  proxyId: null, groupIds: [2, 3],
};

function recoveredAccount(capacity = 16) {
  return { ...originalAccount, id: 1476, capacity };
}

async function fixture(capacity = 16) {
  const rootDirectory = await mkdtemp(join(tmpdir(), "public-recovery-job-"));
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.PUBLIC_RECOVERY_TEST_TOKEN;
  process.env.PUBLIC_RECOVERY_TEST_TOKEN = "test-admin-token";
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const config = {
    rootDirectory,
    bugTeam: { requestTimeoutMs: 1000 },
    sub2api: { requestTimeoutMs: 1000 },
    operations: { accountImportDefaults: { priority: 1, capacity: 3, rateMultiplier: 1000, groupIds: [2, 3], perAccountProxy: false } },
  } as unknown as AppConfig;
  const target = { mode: "http", baseUrl: "https://api.test", adminToken: { envKey: "PUBLIC_RECOVERY_TEST_TOKEN" } } as HttpCliTarget;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ path: url.pathname, body });
    if (url.hostname === "30d.team" && url.pathname.endsWith("health-check")) {
      return new Response(JSON.stringify({ ok: true, healthy: 1, need_reclaim: 0 }), { status: 200 });
    }
    if (url.hostname === "30d.team" && url.pathname.endsWith("batch-cards")) {
      return new Response(JSON.stringify({ ok: true, data: { tasks: [{ order_no: "order-safe", download_token: "token-safe" }] } }), { status: 200 });
    }
    if (url.hostname === "30d.team" && url.pathname.includes("/download")) return new Response("{}", { status: 200 });
    if (url.pathname === "/api/admin/accounts/inspect") {
      const ids = Array.isArray(body.accountIds) ? body.accountIds : [];
      return new Response(JSON.stringify({ ok: true, accounts: ids.includes(1473) ? [originalAccount] : [recoveredAccount(capacity)] }), { status: 200 });
    }
    if (url.pathname === "/api/account-import/jobs" && init?.method === "POST") {
      return new Response(JSON.stringify({ ok: true, job: { id: "import-job", state: "queued" } }), { status: 200 });
    }
    if (url.pathname === "/api/account-import/jobs/import-job") {
      return new Response(JSON.stringify({ ok: true, job: { id: "import-job", state: "succeeded", result: { createdIds: [1476] } } }), { status: 200 });
    }
    throw new Error("unexpected mocked request " + url.pathname);
  }) as typeof fetch;
  return {
    rootDirectory, config, target, requests,
    cleanup: async () => {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.PUBLIC_RECOVERY_TEST_TOKEN;
      else process.env.PUBLIC_RECOVERY_TEST_TOKEN = originalToken;
      await rm(rootDirectory, { recursive: true, force: true });
    },
  };
}

test("recovery job freezes the original configuration and advances one stage at a time", async () => {
  const setup = await fixture();
  const output = join(setup.rootDirectory, "recovered.json");
  try {
    const manager = new PublicRecoveryJobManager(setup.config, setup.target);
    const job = await manager.create({ accountId: 1473, baseUrl: "https://30d.team", outputPath: output, unitCostCny: 0.01, planType: "team" });
    expect(job.recoveryConfig).toMatchObject({ capacity: 16, priority: 1, groupIds: [2, 3], proxyId: 0, status: "error", schedulable: false });
    expect(setup.requests).toHaveLength(1);

    expect(await manager.run(job.id, "team-card-secret")).toMatchObject({ state: "waiting", stage: "health", nextStage: "status" });
    expect(await manager.run(job.id, "team-card-secret")).toMatchObject({ state: "waiting", stage: "status", nextStage: "download" });
    expect(await manager.run(job.id, "team-card-secret")).toMatchObject({ state: "waiting", stage: "download", nextStage: "import-submit" });
    expect(await manager.run(job.id, "")).toMatchObject({ state: "waiting", stage: "import-submit", nextStage: "import-status" });
    const submission = setup.requests.find((request) => request.path === "/api/account-import/jobs");
    expect(submission?.body).toMatchObject({
      priority: 1, capacity: 16, rateMultiplier: 1000, groupIds: [2, 3], sourceProxyId: 0,
      cutoffTrigger: "public-recovery", allowDuplicate: true,
      recoveryConfig: expect.objectContaining({ capacity: 16, status: "error", schedulable: false }),
    });
    expect(await manager.run(job.id, "")).toMatchObject({ state: "waiting", stage: "import-status", nextStage: "verify", revivedAccountIds: [1476] });
    expect(await manager.run(job.id, "")).toMatchObject({ state: "succeeded", stage: "done", nextStage: null, revivedAccountIds: [1476] });

    const persisted = await readFile(join(setup.rootDirectory, ".state", "public-recovery", job.id + ".json"), "utf8");
    expect(persisted).not.toContain("team-card-secret");
    expect(persisted).not.toContain("download_token");
  } finally {
    await setup.cleanup();
  }
});

test("recovery job fails verification when the new OAuth account does not inherit capacity", async () => {
  const setup = await fixture(3);
  const output = join(setup.rootDirectory, "recovered.json");
  try {
    const manager = new PublicRecoveryJobManager(setup.config, setup.target);
    const job = await manager.create({ accountId: 1473, baseUrl: "https://30d.team", outputPath: output, unitCostCny: 0.01, planType: "team" });
    await manager.run(job.id, "team-card-secret");
    await manager.run(job.id, "team-card-secret");
    await manager.run(job.id, "team-card-secret");
    await manager.run(job.id, "");
    await manager.run(job.id, "");
    expect(await manager.run(job.id, "")).toMatchObject({ state: "failed", stage: "verify", nextStage: "verify" });
  } finally {
    await setup.cleanup();
  }
});

test("legacy job without a frozen configuration cannot resume", async () => {
  const setup = await fixture();
  try {
    const manager = new PublicRecoveryJobManager(setup.config, setup.target);
    await Bun.write(join(setup.rootDirectory, ".state", "public-recovery", "legacy.json"), JSON.stringify({
      version: 1, id: "legacy", logs: [],
    }));
    await expect(manager.get("legacy")).rejects.toThrow("lacks the required configuration snapshot");
  } finally {
    await setup.cleanup();
  }
});
