import type { AppConfig } from "./config";
import type { OperationsStore } from "./operations-store";
import type { ProbeIsolationService } from "./probe-isolation";

interface Probe {
  id: string;
  dimension: "instruction" | "reasoning" | "structure" | "context";
  prompt: string;
  judge: (answer: string) => boolean;
}

export const upstreamBenchmarkProbes: Probe[] = [
  { id: "exact", dimension: "instruction", prompt: "Return exactly READY-803 and nothing else.", judge: (v) => v.trim() === "READY-803" },
  { id: "json", dimension: "structure", prompt: '只输出合法 JSON，不要 Markdown，不要解释。字段必须且只能包含：{"risk":"low|medium|high","pass":boolean,"reasons":string[]}。场景：接口返回 HTTP 200，但正文因长度限制在中途结束。', judge: (v) => { try { const x = JSON.parse(v.trim()); return Object.keys(x).sort().join(",") === "pass,reasons,risk" && x.pass === false && ["medium", "high"].includes(x.risk) && Array.isArray(x.reasons); } catch { return false; } } },
  { id: "filter", dimension: "instruction", prompt: "从下面节点中筛选全部符合条件的项目，只输出节点名，用顿号分隔，不要解释。条件：延迟不高于900ms；支持流式；余额大于50；状态=可用。苍穹 延迟820 流式=是 余额68 状态=可用；青禾 延迟910 流式=是 余额120 状态=可用；赤湾 延迟760 流式=否 余额86 状态=可用；云帆 延迟880 流式=是 余额50 状态=可用；星港 延迟640 流式=是 余额92 状态=可用。", judge: (v) => v.replace(/\s/gu, "") === "苍穹、星港" },
  { id: "math", dimension: "reasoning", prompt: "只输出最终数字。某服务连续三小时请求量分别为1200、1500、1800，失败率分别为2%、4%、5%。三小时总失败请求数是多少？", judge: (v) => /(?:^|\D)174(?:\D|$)/u.test(v.trim()) },
  { id: "logic", dimension: "reasoning", prompt: "只输出 A、B、C、D 中的一个字母。四个任务A、B、C、D满足：A在B之前；C在D之后；B在C之前。哪个任务一定最先？", judge: (v) => v.trim().replace(/[.。]/gu, "") === "A" },
  { id: "context", dimension: "context", prompt: "记住口令 K7M2。先计算 17*19，再忽略计算结果。只输出最开始的口令，不要解释。", judge: (v) => v.trim() === "K7M2" },
];

function answerText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const content = Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as unknown[] : [];
    return content.map((part) => part && typeof part === "object" ? String((part as Record<string, unknown>).text ?? "") : "");
  }).join("");
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/sk-[A-Za-z0-9_-]+/gu, "[REDACTED]").slice(0, 240);
}

export class UpstreamBenchmarkService {
  constructor(private readonly config: AppConfig, private readonly store: OperationsStore, private readonly isolation: ProbeIsolationService | null) {}

  async run(accountId: number, model: string): Promise<Record<string, unknown>> {
    const policy = this.config.operations.upstreamBenchmark;
    if (!policy.enabled) throw new Error("上游智商评测未启用");
    if (!this.isolation) throw new Error("探活隔离服务不可用");
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error("上游账号 ID 无效");
    if (!this.isolation.get(accountId)) throw new Error(`账号 ${accountId} 的探活专用 API Key 尚未就绪`);
    const selectedModel = model.trim() || policy.model;
    const runId = await this.store.startUpstreamBenchmark({ accountId, provider: policy.provider, benchmarkVersion: policy.benchmarkVersion, model: selectedModel });
    const started = Date.now();
    const results: Array<Record<string, unknown>> = [];
    try {
      for (const probe of upstreamBenchmarkProbes) {
        const probeStarted = Date.now();
        try {
          const payload = await this.isolation.request(accountId, probe.prompt, selectedModel, 1000, policy.requestTimeoutMs);
          const answer = answerText(payload);
          results.push({ id: probe.id, dimension: probe.dimension, requestSucceeded: true, passed: probe.judge(answer), durationMs: Date.now() - probeStarted });
        } catch (error) {
          results.push({ id: probe.id, dimension: probe.dimension, requestSucceeded: false, passed: false, durationMs: Date.now() - probeStarted, error: safeError(error) });
        }
      }
      const successfulRequests = results.filter((item) => item.requestSucceeded === true).length;
      if (successfulRequests === 0) {
        const message = "所有评测请求均失败，本轮没有有效分数";
        await this.store.finishUpstreamBenchmark(runId, { state: "failed", score: null, dimensions: {}, probes: results, durationMs: Date.now() - started, errorSummary: message });
        return { ok: false, state: "failed", runId, accountId, provider: policy.provider, benchmarkVersion: policy.benchmarkVersion, model: selectedModel, score: null, dimensions: {}, probes: results, durationMs: Date.now() - started, error: message, valuesPrinted: false };
      }
      const dimensions = Object.fromEntries([...new Set(upstreamBenchmarkProbes.map((item) => item.dimension))].map((dimension) => {
        const rows = results.filter((item) => item.dimension === dimension);
        return [dimension, Math.round(rows.filter((item) => item.passed === true).length / rows.length * 100)];
      }));
      const score = Math.round(results.filter((item) => item.passed === true).length / results.length * 1000) / 10;
      await this.store.finishUpstreamBenchmark(runId, { state: "succeeded", score, dimensions, probes: results, durationMs: Date.now() - started, errorSummary: null });
      return { ok: true, runId, accountId, provider: policy.provider, benchmarkVersion: policy.benchmarkVersion, model: selectedModel, score, dimensions, probes: results, durationMs: Date.now() - started, valuesPrinted: false };
    } catch (error) {
      const message = safeError(error);
      await this.store.finishUpstreamBenchmark(runId, { state: "failed", score: null, dimensions: {}, probes: results, durationMs: Date.now() - started, errorSummary: message });
      throw new Error(message);
    }
  }
}
