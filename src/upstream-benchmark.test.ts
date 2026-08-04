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
    async startUpstreamBenchmark() { return "run-1"; },
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
  const result = await new UpstreamBenchmarkService(config, store, isolation).run(42, "fixture");
  expect(result.score).toBe(100);
  expect(JSON.stringify(result)).not.toContain("sk-secret");
  expect(JSON.stringify(persisted)).not.toContain("sk-secret");
});

test("benchmark does not publish zero when every request fails", async () => {
  let finished: Record<string, unknown> | null = null;
  const config = { operations: { upstreamBenchmark: { enabled: true, provider: "https://apitest.work/", benchmarkVersion: "fixture-v1", model: "fixture", requestTimeoutMs: 1000 } } } as never;
  const store = {
    async startUpstreamBenchmark() { return "run-2"; },
    async finishUpstreamBenchmark(_id: string, value: Record<string, unknown>) { finished = value; },
  } as never;
  const isolation = {
    get() { return { accountId: 42, groupId: 7, keyCreated: false }; },
    async request() { throw new Error("HTTP 503 with sk-hidden"); },
  } as never;
  const result = await new UpstreamBenchmarkService(config, store, isolation).run(42, "fixture");
  expect(result).toMatchObject({ ok: false, state: "failed", score: null });
  expect(finished).toMatchObject({ state: "failed", score: null });
  expect(JSON.stringify(result)).not.toContain("sk-hidden");
});
