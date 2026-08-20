import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BugTeamPurchaseImportService } from "./bugteam-purchase-import-service";

function config() {
  return {
    operations: {
      accountImportDefaults: { priority: 1, capacity: 16, rateMultiplier: 1000, groupIds: [2, 3], sourceProxyId: 3, perAccountProxy: false },
      accountImportArchiveDirectory: "/tmp/api2business-purchase-test",
    },
  } as never;
}

test("purchase worker resumes an existing order without creating a second order", async () => {
  let createCount = 0;
  let createdOrderInput: unknown[] = [];
  const client = {
    inventory: async () => ({ available: 3, base_unit_price_fen: 300, billing_base_seconds: 3600, estimated_unit_price_fen: 271, estimated_total_fen: 271, hold_total_fen: 300 }),
    inventoryShelves: async () => ({ buckets: [
      { bucket_start: "cheap", available: 1, minimum_remaining_seconds: 1200 },
      { bucket_start: "later", available: 3, minimum_remaining_seconds: 3000 },
    ] }),
    createOrder: async (...args: unknown[]) => { createCount += 1; createdOrderInput = args; return { order_id: "order-1", state: "created" }; },
    orderStatus: async () => ({ state: "completed", actual_total_fen: 271 }),
    download: async (_orderId: string, _format: string, output: string) => {
      await mkdir(dirname(output), { recursive: true });
      await Bun.write(output, JSON.stringify({ accounts: [{ platform: "openai", credentials: { access_token: "token" } }], proxies: [] }));
      return { ok: true, bytes: 100 };
    },
  };
  const imports = {
    submit: async () => ({ id: "import-1", state: "succeeded", logs: [], settings: { planType: "team" } }),
    get: async () => ({ id: "import-1", state: "succeeded", logs: [], settings: { planType: "team" } }),
  };
  const temporal = { submit: async () => ({ ok: true, workflowId: "workflow-1", runId: "run-1", state: "submitted" }) };
  const service = new BugTeamPurchaseImportService(config(), temporal as never, {
    get: async (id) => service.workerGet(id),
    patch: async (id, patch) => { service.applyWorkerPatch(id, patch); },
  }, client as never, imports as never);
  const submitted = await service.submit({ quantity: 1, priority: 1, capacity: 16, rateMultiplier: 1000, groupIds: [2, 3], sourceProxyId: 3 });
  const first = await service.runWorker(submitted.id);
  const second = await service.runWorker(submitted.id);
  expect(first.state).toBe("succeeded");
  expect(first.quote?.estimatedUnitPriceCny).toBe(2);
  expect(first.quote?.estimatedTotalCny).toBe(2);
  expect(first.quote?.holdTotalCny).toBe(3);
  expect(second.state).toBe("succeeded");
  expect(createCount).toBe(1);
  expect(createdOrderInput[3]).toBe("cheap");
  expect(submitted.settings.rateMultiplier).toBe(1000);
});

test("purchase refuses to fall back when the cheapest shelf cannot satisfy the whole order", async () => {
  const client = {
    inventory: async () => ({ base_unit_price_fen: 300, billing_base_seconds: 3600, hold_total_fen: 300 }),
    inventoryShelves: async () => ({ buckets: [
      { bucket_start: "cheap", available: 1, minimum_remaining_seconds: 1200 },
      { bucket_start: "later", available: 2, minimum_remaining_seconds: 3000 },
    ] }),
  };
  const temporal = { submit: async () => ({ ok: true, workflowId: "workflow-2", runId: "run-2", state: "submitted" }) };
  const service = new BugTeamPurchaseImportService(config(), temporal as never, {
    get: async (id) => service.workerGet(id),
    patch: async (id, patch) => { service.applyWorkerPatch(id, patch); },
  }, client as never, {
    submit: async () => ({ id: "import-2", state: "succeeded", logs: [], settings: { planType: "team" } }),
    get: async () => ({ id: "import-2", state: "succeeded", logs: [], settings: { planType: "team" } }),
  } as never);
  const submitted = await service.submit({ quantity: 3, priority: 1, capacity: 16, groupIds: [2, 3], sourceProxyId: 3 });
  await expect(service.runWorker(submitted.id)).rejects.toThrow("单一最低价车次");
  const result = service.workerGet(submitted.id)!;
  expect(result.state).toBe("failed");
  expect(result.error).toContain("单一最低价车次");
});
