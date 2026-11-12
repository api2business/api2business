import { createHash, randomInt } from "node:crypto";

export const MATH_PROBE_SYSTEM_PROMPT = [
  "你是 API 探活计算器。",
  "计算下面两个两位整数的和。",
  "只输出最终结果的十进制整数，不要解释。不得输出思考过程、推导、等式、Markdown、XML/JSON 标签、标点、单位、前后缀或任何其他文字；除这个整数外不得包含任何其他字符。",
].join("");

// 固定前缀用于让上游 prompt cache 命中。OpenAI 系列模型只对达到最小缓存长度
// 的前缀做缓存；探活原本只有不到一百个 token，每次都会以 cache_read=0 计费，
// 连续探活会被上游的零缓存保护识别为异常流量。以下内容必须保持常量：
// 不包含时间、账号 ID、随机数或任何供应商/租户信息。
export const PROBE_CACHE_HISTORY_INTRO = [
  "下面是一组固定的算术格式示例，只用于稳定请求前缀。",
  "示例按固定编号连续排列，编号只用于保持前缀一致，不代表任何运行顺序或状态。",
  "每个示例都遵循同一规则：只给出两个两位整数相加后的十进制结果。",
  "示例不涉及账号、租户、时间、网络环境或任何运行状态。",
].join("");

export interface ProbeCacheHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

function probeCacheExample(index: number): { prompt: string; answer: number } {
  // 纯函数生成，确保不同进程、不同机器和重启后得到完全相同的前缀。
  const left = 10 + ((index * 37 + 11) % 90);
  const right = 10 + ((index * 53 + 29) % 90);
  return {
    prompt: `Example ${String(index + 1).padStart(3, "0")}: ${left} + ${right} = ?`,
    answer: left + right,
  };
}

function buildProbeCacheHistory(exampleCount = 256): ProbeCacheHistoryMessage[] {
  const messages: ProbeCacheHistoryMessage[] = [
    { role: "user", content: PROBE_CACHE_HISTORY_INTRO },
    { role: "assistant", content: "收到。后续每个问题都只输出最终十进制整数。" },
  ];
  // 256 个示例保证内容本身在常见分词器下明显超过 1024 token 的最小缓存长度；
  // 即使供应商只统计 content、不统计消息开销，也能稳定形成可缓存前缀。
  for (let index = 0; index < exampleCount; index += 1) {
    const example = probeCacheExample(index);
    messages.push({ role: "user", content: example.prompt });
    messages.push({ role: "assistant", content: String(example.answer) });
  }
  return messages;
}

export const PROBE_CACHE_HISTORY: readonly ProbeCacheHistoryMessage[] = Object.freeze(buildProbeCacheHistory());

export const PROBE_CACHE_PREFIX_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify({ system: MATH_PROBE_SYSTEM_PROMPT, history: PROBE_CACHE_HISTORY }))
  .digest("hex");

// 零命中账号使用的紧凑前缀：仍是同一套确定性算术示例的前缀截断，只是把示例数减半。
// 长度必须继续明显高于常见上游 1024 token 的最小缓存长度，这样一旦上游恢复缓存能力
// 仍然可以命中；它只在连续 24 小时已知缓存样本全部为 0 的账号上启用，任何有过命中或
// 缓存字段未知的账号继续使用完整前缀，命中率不会被这次省钱改动牺牲。
export const PROBE_COMPACT_CACHE_HISTORY: readonly ProbeCacheHistoryMessage[] = Object.freeze(
  buildProbeCacheHistory(128),
);

export const PROBE_COMPACT_CACHE_PREFIX_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify({ system: MATH_PROBE_SYSTEM_PROMPT, history: PROBE_COMPACT_CACHE_HISTORY }))
  .digest("hex");

export type MathProbeCacheMode = "full" | "compact";

// 稳定路由键让上游把重复探活放进同一缓存分片；它不是 prompt 内容，也不含账号信息。
export const PROBE_CACHE_ROUTING_KEY = "api2business-idle-probe-v1";

export type MathProbeTransport = "responses" | "chat_completions";

export interface MathProbeRequestInput {
  model: string;
  question: string;
  transport: MathProbeTransport;
  reasoningEffort?: "low" | "medium" | "high";
  maxOutputTokens?: number;
  cacheMode?: MathProbeCacheMode;
}

export interface MathProbeRequestBody {
  body: Record<string, unknown>;
  cachePrefixFingerprint: string;
}

export function buildMathProbeRequestBody(input: MathProbeRequestInput): MathProbeRequestBody {
  const maxOutputTokens = input.maxOutputTokens ?? 256;
  const compact = input.cacheMode === "compact";
  const history = compact ? PROBE_COMPACT_CACHE_HISTORY : PROBE_CACHE_HISTORY;
  const fingerprint = compact ? PROBE_COMPACT_CACHE_PREFIX_FINGERPRINT : PROBE_CACHE_PREFIX_FINGERPRINT;
  if (input.transport === "chat_completions") {
    return {
      cachePrefixFingerprint: fingerprint,
      body: {
        model: input.model,
        messages: [
          { role: "system", content: MATH_PROBE_SYSTEM_PROMPT },
          ...history,
          { role: "user", content: input.question },
        ],
        max_tokens: maxOutputTokens,
        stream: true,
      },
    };
  }
  return {
    cachePrefixFingerprint: fingerprint,
    body: {
      model: input.model,
      instructions: MATH_PROBE_SYSTEM_PROMPT,
      input: [
        ...history,
        { role: "user", content: input.question },
      ],
      reasoning: { effort: input.reasoningEffort ?? "low" },
      max_output_tokens: maxOutputTokens,
      prompt_cache_key: PROBE_CACHE_ROUTING_KEY,
      prompt_cache_retention: "24h",
      store: false,
      stream: true,
    },
  };
}

export interface MathProbeQuestion {
  questionId: string;
  seed: number;
  left: number;
  right: number;
  prompt: string;
  expectedAnswer: number;
}

export type MathProbeAnswerClassification = "correct" | "wrong_number" | "format_invalid" | "empty";

export interface MathProbeAnswerResult {
  classification: MathProbeAnswerClassification;
  raw: string;
  parsedAnswer: number | null;
  trimmedNumeric: boolean;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

export function createMathProbeQuestion(seed = randomInt(0, 0x1_0000_0000)): MathProbeQuestion {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xFFFF_FFFF) {
    throw new Error("math probe seed must be an unsigned 32-bit integer");
  }
  const next = seededRandom(seed);
  const left = 10 + Math.floor(next() * 90);
  const right = 10 + Math.floor(next() * 90);
  return {
    questionId: `addition-v1-${seed}`,
    seed,
    left,
    right,
    prompt: `${left} + ${right}`,
    expectedAnswer: left + right,
  };
}

export function parseMathProbeAnswer(raw: string, expectedAnswer: number): MathProbeAnswerResult {
  const strictInteger = /^(0|[1-9][0-9]*)$/u;
  const normalized = raw.trim();
  if (normalized.length === 0) {
    return { classification: "empty", raw, parsedAnswer: null, trimmedNumeric: false };
  }
  // Tokenizers commonly emit one leading or trailing space. Treat surrounding
  // whitespace as transport noise while still rejecting text and markup.
  if (!strictInteger.test(normalized)) {
    return { classification: "format_invalid", raw, parsedAnswer: null, trimmedNumeric: false };
  }
  const parsedAnswer = Number(normalized);
  return {
    classification: parsedAnswer === expectedAnswer ? "correct" : "wrong_number",
    raw,
    parsedAnswer,
    trimmedNumeric: true,
  };
}
