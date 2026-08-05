import { expect, test } from "bun:test";
import { UpstreamBenchmarkService, upstreamBenchmarkProbes } from "./upstream-benchmark";

test("compatible benchmark judges deterministic public probes", () => {
  const answers = ["READY-803", '{"risk":"high","pass":false,"reasons":["truncated"]}', "苍穹、星港", "174", "A", "K7M2"];
  expect(upstreamBenchmarkProbes.map((probe, index) => probe.judge(answers[index]!))).toEqual([true, true, true, true, true, true]);
});

test("benchmark persists summaries without exposing the probe API key", async () => {
  const persisted: Record<string, unknown>[] = [];
  const config = { operations: { upstreamBenchmark: { enabled: true, provider: "https://apitest.work/", benchmarkVersion: "fixture-v1", model: "fixture", requestTimeoutMs: 1000 } } } as never;
  const store = {
    async addUpstreamBenchmarkEvent(_id: string, value: Record<string, unknown>) { persisted.push({ event: value }); },
    async finishUpstreamBenchmark(_id: string, value: Record<string, unknown>) { persisted.push(value); },
  } as never;
  let calls = 0;
  const isolation = {
    get() { return { accountId: 42, groupId: 7, keyCreated: false }; },
    async request() {
      const answer = ["READY-803", '{"risk":"high","pass":false,"reasons":["x"]}', "苍穹、星港", "174", "A", "K7M2"][calls++]!;
      return { output_text: answer, internal: "sk-secret-must-not-escape" };
    },
  } as never;
  const result = await new UpstreamBenchmarkService(config, store, isolation).run("run-1", 42, "fixture");
  expect(result.score).toBe(100);
  expect(JSON.stringify(result)).not.toContain("sk-secret");
  expect(JSON.stringify(persisted)).not.toContain("sk-secret");
});

test("benchmark does not publish zero when every request fails", async () => {
  let finished: Record<string, unknown> | null = null;
  const config = { operations: { upstreamBenchmark: { enabled: true, provider: "https://apitest.work/", benchmarkVersion: "fixture-v1", model: "fixture", requestTimeoutMs: 1000 } } } as never;
  const store = {
    async addUpstreamBenchmarkEvent() {},
    async finishUpstreamBenchmark(_id: string, value: Record<string, unknown>) { finished = value; },
  } as never;
  const isolation = {
    get() { return { accountId: 42, groupId: 7, keyCreated: false }; },
    async request() { throw new Error("HTTP 503 with sk-hidden"); },
  } as never;
  const result = await new UpstreamBenchmarkService(config, store, isolation).run("run-2", 42, "fixture");
  expect(result).toMatchObject({ ok: false, state: "failed", score: null });
  expect(finished).toMatchObject({ state: "failed", score: null });
  expect(JSON.stringify(result)).not.toContain("sk-hidden");
});

test("benchmark emits ordered progress without response bodies or keys", async () => {
  const events: Record<string, unknown>[] = [];
  const config = { operations: { upstreamBenchmark: { enabled: true, provider: "fixture", benchmarkVersion: "v1", model: "fixture", requestTimeoutMs: 1000 } } } as never;
  const store = {
    async addUpstreamBenchmarkEvent(_id: string, value: Record<string, unknown>) { events.push(value); },
    async finishUpstreamBenchmark() {},
  } as never;
  const isolation = {
    get() { return { accountId: 42 }; },
    async request() { return { output_text: "wrong", authorization: "Bearer sk-never-store" }; },
  } as never;
  await new UpstreamBenchmarkService(config, store, isolation).run("run-3", 42, "fixture");
  expect(events.map((event) => event.stage)).toEqual([
    "worker-started", "identity-ready",
    "probe-started", "probe-succeeded", "probe-started", "probe-succeeded",
    "probe-started", "probe-succeeded", "probe-started", "probe-succeeded",
    "probe-started", "probe-succeeded", "probe-started", "probe-succeeded",
    "scoring", "completed",
  ]);
  expect(JSON.stringify(events)).not.toContain("sk-never-store");
  expect(events.filter((event) => event.stage === "probe-started")).toHaveLength(6);
});
