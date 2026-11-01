import { randomInt } from "node:crypto";

export const MATH_PROBE_SYSTEM_PROMPT = [
  "你是 API 探活计算器。",
  "计算下面两个两位整数的和，只输出最终整数，不要解释。",
].join("");

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
  const trimmedNumeric = strictInteger.test(normalized);
  if (raw.trim().length === 0) {
    return { classification: "empty", raw, parsedAnswer: null, trimmedNumeric: false };
  }
  if (!strictInteger.test(raw)) {
    return {
      classification: "format_invalid",
      raw,
      parsedAnswer: trimmedNumeric ? Number(normalized) : null,
      trimmedNumeric,
    };
  }
  const parsedAnswer = Number(raw);
  return {
    classification: parsedAnswer === expectedAnswer ? "correct" : "wrong_number",
    raw,
    parsedAnswer,
    trimmedNumeric: true,
  };
}
