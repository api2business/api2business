import { expect, test } from "bun:test";
import type { AppConfig } from "./config";
import type { Sub2ApiClient } from "./sub2api-client";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import { reconcileGatewayServicePolicy } from "./gateway-service-policy";

const config = { sub2api: { gatewayServicePolicy: { denyAudio: true, requiredModelsByPlatform: { openai: ["gpt-6.1-sol"] } } } } as unknown as AppConfig;
function fixture(mismatch = false) {
  const groups: Record<string, any>[] = [
    { id: 2, platform: "openai", allow_live: true, rate_multiplier: 3, model_allowlist: { enabled: false, models: ["gpt-image-2", "gpt-4o-audio-preview"] } },
    { id: 9, platform: "openai", allow_live: false, model_allowlist: { enabled: false } },
    { id: 62, platform: "grok", allow_live: false, model_allowlist: { enabled: false, models: ["grok-4.7"] } },
  ];
  const calls: unknown[] = [];
  const client = {
    async request(path: string) { return structuredClone(path.endsWith("/all") ? groups : groups.find((g) => path.endsWith(`/${g.id}`))); },
    async mutate(method: string, path: string, patch: object) { calls.push({ method, path, patch }); if (!mismatch) Object.assign(groups.find((g) => path.endsWith(`/${g.id}`))!, patch); },
  } as unknown as Sub2ApiClient;
  const reads = { async query() { return { rows: [ { platform: "openai", models: ["gpt-6-astra", "gpt-4o-realtime-preview", "*"] }, { platform: "grok", models: ["grok-voice-latest"] } ] }; } } as unknown as Sub2ApiReadClient;
  return { client, reads, calls, groups };
}

test("service policy previews safely, repairs every group, and converges without repeated writes", async () => {
  const f = fixture();
  expect((await reconcileGatewayServicePolicy(f.client, f.reads, config, false)).changedCount).toBe(3);
  expect(f.calls).toHaveLength(0);
  expect((await reconcileGatewayServicePolicy(f.client, f.reads, config, true)).updated).toBe(3);
  expect(f.groups[0]?.model_allowlist).toEqual({ enabled: true, models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-image-2"] });
  expect(f.groups[0]?.rate_multiplier).toBe(3);
  expect(f.groups.every((g) => g.allow_live === false)).toBe(true);
  expect(f.groups[2]?.model_allowlist.models).toEqual(["grok-4.7"]);
  expect((await reconcileGatewayServicePolicy(f.client, f.reads, config, true)).changedCount).toBe(0);
  expect(f.calls).toHaveLength(3);
});

test("a native update that is not persisted cannot report policy success", async () => {
  const f = fixture(true);
  await expect(reconcileGatewayServicePolicy(f.client, f.reads, config, true)).rejects.toThrow("readback mismatch");
});
