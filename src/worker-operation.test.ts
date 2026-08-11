import { expect, test } from "bun:test";
import { createWorkerOperationExecutor } from "./worker-operation";

function services(overrides: Record<string, unknown> = {}) {
  const completed: string[] = [];
  const cached: Array<Record<string, unknown>> = [];
  const synchronized: Array<Record<string, unknown>> = [];
  const upstreams = {
    claimOperation: () => null,
    completeOperation: (id: string) => { completed.push(id); return { ok: true }; },
    configuredUnprobedFallbackRate: () => 0.1,
    create: async () => ({ ok: true, account: { id: 42 }, warnings: [] }),
    usage: async () => ({ ok: true, results: [{ accountId: 42 }], apiAmountUsdTotal: 3 }),
    synchronizeDetectedRates: async (_results: unknown[], options: Record<string, unknown> = {}) => {
      synchronized.push(options);
      return { ok: true };
    },
    update: async () => ({ ok: true }),
    recharge: async () => ({ ok: true }),
    ensureProbeIsolation: async () => ({ ok: true }),
    applyTemplate: async () => ({ ok: true }),
    ...overrides,
  };
  const operations = {
    setUpstreamUsageCache: async (results: Array<Record<string, unknown>>) => { cached.push(...results); },
    sampleOAuthRuntime: async () => ({ ok: true }),
    samplePoolQuality: async () => ({ ok: true }),
    runDueAutomation: async () => ({ ok: true }),
    deferPriorityAutomationAfterDispatchFailure: async () => ({ ok: true }),
  };
  return {
    value: {
      dispatcher: { executeDirect: async () => ({ ok: true }) },
      scores: { refresh: async () => ({ ok: true }) },
      operations,
      imports: {}, lifecycle: {}, upstreams, temporal: null,
    },
    completed, cached, synchronized, operations, upstreams,
  };
}

test("worker executor preserves create detection, rate synchronization, and completion", async () => {
  const fixture = services({
    claimOperation: () => ({
      action: "create",
      input: { baseUrl: "https://example.com", apiKey: "sk-test", suffix: "one", rateCnyPerApiUsd: 1, rateWasSpecified: false },
    }),
  });
  const execute = createWorkerOperationExecutor(fixture.value as never);
  const result = await execute({ operationId: "create-1", command: { kind: "upstream.operation", operationId: "create-1" } }) as Record<string, unknown>;
  expect(result.detection).toBeTruthy();
  expect(fixture.synchronized).toEqual([{ fallbackRateCnyPerApiUsd: 0.1 }]);
  expect(fixture.cached).toHaveLength(1);
  expect(fixture.completed).toEqual(["create-1"]);
});

test("worker executor applies fallback rate when post-create detection fails", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const fixture = services({
    claimOperation: () => ({
      action: "create",
      input: { baseUrl: "https://example.com", apiKey: "sk-test", suffix: "one", rateCnyPerApiUsd: 1, rateWasSpecified: false },
    }),
    usage: async () => { throw new Error("probe timeout"); },
    update: async (_id: number, input: Record<string, unknown>) => { updates.push(input); return { ok: true }; },
  });
  const execute = createWorkerOperationExecutor(fixture.value as never);
  const result = await execute({ operationId: "create-2", command: { kind: "upstream.operation", operationId: "create-2" } }) as Record<string, unknown>;
  expect(updates).toEqual([{ rateCnyPerApiUsd: 0.1 }]);
  expect(String((result.warnings as string[])[0])).toContain("已回退费率 0.1");
  expect(fixture.completed).toEqual(["create-2"]);
});

test("worker executor persists automation failure deferral before retry", async () => {
  let deferred = 0;
  const fixture = services();
  fixture.operations.runDueAutomation = async () => { throw new Error("dispatch failed"); };
  fixture.operations.deferPriorityAutomationAfterDispatchFailure = async () => { deferred += 1; return { ok: true }; };
  const execute = createWorkerOperationExecutor(fixture.value as never);
  await expect(execute({ operationId: "automation-1", command: { kind: "priority.automation.run" } })).rejects.toThrow("dispatch failed");
  expect(deferred).toBe(1);
});
