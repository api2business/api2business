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
    priorityAutomationDispatchDelay: async () => ({ due: false, delayMs: 637000, reason: "waiting" }),
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

test("worker executor returns the authoritative automation delay", async () => {
  const fixture = services();
  const execute = createWorkerOperationExecutor(fixture.value as never);
  const result = await execute({ operationId: "automation-delay", command: { kind: "priority.automation.run" } }) as Record<string, unknown>;
  expect(result).toMatchObject({ ok: true, nextDelayMs: 637000, nextDelayReason: "waiting" });
});

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

test("successful OpenAI OAuth imports submit an independent 120 second API Key cutoff", async () => {
  const submitted: Array<Record<string, unknown>> = [];
  const execute = createWorkerOperationExecutor({
    imports: {
      runWorker: async () => ({
        id: "import-1",
        state: "succeeded",
        source: { platform: "openai", accountType: "oauth" },
      }),
    },
    temporal: { submit: async (command: Record<string, unknown>) => {
      submitted.push(command);
      return { ok: true, workflowId: `workflow-${submitted.length}`, runId: `run-${submitted.length}`, state: "submitted" };
    } },
  } as never);

  const result = await execute({ operationId: "operation-1", command: { kind: "account.import", jobId: "import-1" } }) as Record<string, unknown>;

  expect(submitted).toEqual([
    { kind: "oauth.runtime.sample" },
    expect.objectContaining({ kind: "upstream.apikey.cutoff", phase: "start", durationSeconds: 120 }),
  ]);
  expect(result.postImportApiKeyCutoff).toEqual(expect.objectContaining({ workflowId: "workflow-2" }));
});

test("API Key imports do not trigger the OAuth post-import cutoff", async () => {
  const submitted: Array<Record<string, unknown>> = [];
  const execute = createWorkerOperationExecutor({
    imports: {
      runWorker: async () => ({
        id: "import-2",
        state: "succeeded",
        source: { platform: "openai", accountType: "apikey" },
      }),
    },
    temporal: { submit: async (command: Record<string, unknown>) => {
      submitted.push(command);
      return { ok: true, workflowId: "workflow-1", runId: "run-1", state: "submitted" };
    } },
  } as never);

  await execute({ operationId: "operation-2", command: { kind: "account.import", jobId: "import-2" } });

  expect(submitted).toEqual([{ kind: "oauth.runtime.sample" }]);
});
