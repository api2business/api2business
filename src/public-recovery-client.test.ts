import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicRecoveryClient, validatePublicRecoveryBaseUrl } from "./public-recovery-client";

test("public recovery validates an HTTPS origin", () => {
  expect(validatePublicRecoveryBaseUrl("https://30d.team/")).toBe("https://30d.team");
  expect(() => validatePublicRecoveryBaseUrl("http://30d.team")).toThrow();
  expect(() => validatePublicRecoveryBaseUrl("https://30d.team/path")).toThrow();
  expect(() => validatePublicRecoveryBaseUrl("https://user:pass@30d.team")).toThrow();
});

test("health and reclaim use card_codes and reclaim mode 401", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, healthy: true, need_reclaim: 0, message: "account@example.com team-secret", data: { tasks: [{ status: "ready" }] } }), { status: 200 });
  };
  try {
    const client = new PublicRecoveryClient("https://30d.team", 1000);
    expect(await client.health("team-redacted-test")).toMatchObject({ action: "public-recovery-health", healthy: true, needReclaim: 0, taskCount: 1, message: "[redacted] [redacted]", valuesPrinted: false });
    expect(await client.reclaim("team-redacted-test", "401")).toMatchObject({ action: "public-recovery-reclaim", ok: true });
    expect(requests).toEqual([
      { path: "/api/redeem/reclaim/health-check", body: { card_codes: ["team-redacted-test"] } },
      { path: "/api/redeem/reclaim/batch-cards", body: { card_codes: ["team-redacted-test"], mode: "401" } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("download writes atomically, returns a digest, and refuses overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "public-recovery-"));
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (input) => {
    call += 1;
    const url = new URL(String(input));
    if (call === 1) {
      expect(url.pathname).toBe("/api/redeem/reclaim/batch-cards");
      return new Response(JSON.stringify({ ok: true, data: { tasks: [{ order_no: "order-safe", download_token: "token-safe" }] } }), { status: 200 });
    }
    expect(url.pathname).toBe("/api/redeem/orders/order-safe/download");
    expect(url.searchParams.get("token")).toBe("token-safe");
    return new Response("{\"accounts\":[]}", { status: 200 });
  };
  const output = join(directory, "recovered.json");
  try {
    const client = new PublicRecoveryClient("https://30d.team", 1000);
    await expect(client.download("team-redacted-test", output)).resolves.toMatchObject({ ok: true, output, bytes: 15, valuesPrinted: false });
    expect(await readFile(output, "utf8")).toBe("{\"accounts\":[]}");
    await writeFile(join(directory, "existing.json"), "existing");
    await expect(client.download("team-redacted-test", join(directory, "existing.json"))).rejects.toThrow("output already exists");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
