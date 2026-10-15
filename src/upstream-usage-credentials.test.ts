import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { readNewApiCredential } from "./secrets";
import { UpstreamManagementService } from "./upstream-management";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import type { UpstreamUsageResult } from "./upstream-usage";

test("missing wallet credentials do not abort other wallets or read unrelated sources", async () => {
  const config = loadConfig("config/api2business.example.yaml");
  config.sub2api.newApiCredentials = [{
    baseUrl: "https://alias.example.com", walletKey: "https://wallet.example.com",
    username: { sourceRef: "missing-wallet", sourceKey: "USERNAME" },
    password: { sourceRef: "missing-wallet", sourceKey: "PASSWORD" },
  }];
  config.runtime.secretSourcePaths["missing-wallet"] = "/missing-wallet-credential-test/source.env";
  let requested: number[] = [];
  const reads = { query: async () => ({ rows: requested.map((id) => ({
    id, name: `account-${id}`, base_url: id === 1 ? "https://alias.example.com/v1" : "https://healthy.example.com",
    api_key: "sk-private-test", status: "active", schedulable: true,
  })), cached: false, queueDurationMs: 0, queryDurationMs: 0 }) } as unknown as Sub2ApiReadClient;
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetched.push(String(url));
    return new Response(JSON.stringify({ mode: "unrestricted", usage: { total_tokens: 5 } }));
  }) as typeof fetch;
  try {
    const service = new UpstreamManagementService(config, reads);
    requested = [1, 2];
    const result = await service.usage(requested);
    const rows = result.results as UpstreamUsageResult[];
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(rows[0]?.walletKey).toBe("https://wallet.example.com");
    expect(rows[0]?.quota.remaining).toBeNull();
    expect(rows[0]?.error).toContain("只读挂载");
    expect(rows[1]?.ok).toBeTrue();
    expect(fetched.every((url) => url.startsWith("https://healthy.example.com/"))).toBeTrue();
    expect(JSON.stringify(result)).not.toContain("sk-private-test");
    expect(JSON.stringify(result)).not.toContain("/missing-wallet-credential-test/");
    requested = [2];
    expect((await service.usage(requested)).failed).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("wallet credentials recover on the next read after source projection is repaired", () => {
  const directory = mkdtempSync(join(tmpdir(), "wallet-credential-"));
  try {
    const config = loadConfig("config/api2business.example.yaml");
    const path = join(directory, "source.env");
    config.runtime.secretSourcePaths.wallet = path;
    config.sub2api.newApiCredentials = [{ baseUrl: "https://wallet.example.com",
      username: { sourceRef: "wallet", sourceKey: "USERNAME" },
      password: { sourceRef: "wallet", sourceKey: "PASSWORD" } }];
    expect(() => readNewApiCredential(config, "https://wallet.example.com/v1")).toThrow();
    expect(readNewApiCredential(config, "https://other.example.com")).toBeUndefined();
    writeFileSync(path, "USERNAME=test-user\nPASSWORD=test-password\n", { mode: 0o600 });
    expect(readNewApiCredential(config, "https://wallet.example.com/v1")).toEqual({
      username: "test-user", password: "test-password", walletKey: "https://wallet.example.com",
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
});
