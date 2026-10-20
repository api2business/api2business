import { expect, test } from "bun:test";
import { collectSchedulingRuntime, projectSchedulingRuntime } from "./scheduling-runtime-evidence";

test("runtime evidence projects only numeric operational fields, never credentials or arbitrary strings", () => {
  expect(projectSchedulingRuntime({ group: { "3": { current_in_use: 4, max_capacity: 16, waiting_in_queue: 2, credentials: { api_key: "SECRET" } } }, account: [{ account_id: 41, is_available: false, token: "SECRET", name: "private" }] })).toEqual({ group: { "3": { current_in_use: 4, max_capacity: 16, waiting_in_queue: 2 } }, account: [{ account_id: 41, is_available: false }] });
});

test("runtime evidence isolates a failed source and preserves successful live evidence", async () => {
  const calls: string[] = [];
  const result = await collectSchedulingRuntime({
    async getOpsAccountAvailability(group, platform) { calls.push(`${group}:${platform}`); return { group: { "3": { available_count: 2 } } }; },
    async getOpsConcurrency() { throw new Error("Sub2API GET /admin/ops/concurrency failed: HTTP 404 secret text"); },
  }, 3, "openai");
  expect(calls).toEqual(["3:openai"]);
  expect(result.complete).toBeFalse();
  expect(result.availability.data).toEqual({ group: { "3": { available_count: 2 } } });
  expect(result.concurrency).toMatchObject({ status: "unavailable", httpStatus: 404, data: null });
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("runtime evidence validates before making native calls", async () => {
  const client = { async getOpsAccountAvailability() { throw Error("called"); }, async getOpsConcurrency() { throw Error("called"); } };
  await expect(collectSchedulingRuntime(client, 0, "openai")).rejects.toThrow("positive group");
  await expect(collectSchedulingRuntime(client, 3, "wrong")).rejects.toThrow("positive group");
});
