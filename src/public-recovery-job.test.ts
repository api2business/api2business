import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, HttpCliTarget } from "./config";
import { PublicRecoveryJobManager } from "./public-recovery-job";

test("recovery job runs all stages, reuses the selected account, and persists redacted logs", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "public-recovery-job-"));
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.PUBLIC_RECOVERY_TEST_TOKEN;
  process.env.PUBLIC_RECOVERY_TEST_TOKEN = "test-admin-token";
  const config = {
    rootDirectory,
    bugTeam: { requestTimeoutMs: 1000 },
    sub2api: { requestTimeoutMs: 1000 },
    operations: { accountImportDefaults: { priority: 1, capacity: 3, rateMultiplier: 1000, groupIds: [2, 3], perAccountProxy: false } },
  } as unknown as AppConfig;
  const target = { mode: "http", baseUrl: "https://api.test", adminToken: { envKey: "PUBLIC_RECOVERY_TEST_TOKEN" } } as HttpCliTarget;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "30d.team" && url.pathname.endsWith("health-check")) {
      return new Response(JSON.stringify({ ok: true, healthy: 1, need_reclaim: 0 }), { status: 200 });
    }
    if (url.hostname === "30d.team" && url.pathname.endsWith("batch-cards")) {
      return new Response(JSON.stringify({ ok: true, data: { tasks: [{ order_no: "order-safe", download_token: "token-safe" }] } }), { status: 200 });
    }
    if (url.hostname === "30d.team" && url.pathname.includes("/download")) return new Response("{}", { status: 200 });
    if (url.pathname === "/api/admin/accounts/inspect") return new Response(JSON.stringify({ ok: true, accounts: [{ id: 1473, type: "oauth" }] }), { status: 200 });
    if (url.pathname === "/api/account-import/jobs" && init?.method === "POST") return new Response(JSON.stringify({ ok: true, job: { id: "import-job", state: "queued" } }), { status: 200 });
    if (url.pathname === "/api/account-import/jobs/import-job") return new Response(JSON.stringify({ ok: true, job: { id: "import-job", state: "succeeded" } }), { status: 200 });
    throw new Error(`unexpected mocked request ${url.pathname}`);
  }) as typeof fetch;
  const output = join(rootDirectory, "recovered.json");
  try {
    const manager = new PublicRecoveryJobManager(config, target);
    await manager.assertOAuthAccount(1473);
    const job = await manager.create({ accountId: 1473, baseUrl: "https://30d.team", outputPath: output, unitCostCny: 0.01, planType: "team" });
    const result = await manager.runChain(job.id, "team-card-secret");
    expect(result).toMatchObject({ ok: true, state: "succeeded", accountId: 1473, nextStage: null });
    const persisted = await readFile(join(rootDirectory, ".state", "public-recovery", `${job.id}.json`), "utf8");
    expect(persisted).not.toContain("team-card-secret");
    expect(persisted).not.toContain("download_token");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.PUBLIC_RECOVERY_TEST_TOKEN;
    else process.env.PUBLIC_RECOVERY_TEST_TOKEN = originalToken;
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
