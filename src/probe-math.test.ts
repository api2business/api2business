import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildMathProbeRequestBody,
  createMathProbeQuestion,
  MATH_PROBE_SYSTEM_PROMPT,
  parseMathProbeAnswer,
  PROBE_CACHE_HISTORY,
  PROBE_CACHE_PREFIX_FINGERPRINT,
  PROBE_CACHE_ROUTING_KEY,
} from "./probe-math";

test("math probe system prompt requires one bare decimal integer", () => {
  expect(MATH_PROBE_SYSTEM_PROMPT).toContain("只输出最终结果的十进制整数");
  expect(MATH_PROBE_SYSTEM_PROMPT).toContain("不要解释");
  expect(MATH_PROBE_SYSTEM_PROMPT).toContain("不得输出思考过程、推导、等式、Markdown、XML/JSON 标签、标点、单位、前后缀或任何其他文字");
  expect(MATH_PROBE_SYSTEM_PROMPT).toContain("除这个整数外不得包含任何其他字符");
});

test("math probe returns one deterministic two-digit addition", () => {
  const question = createMathProbeQuestion(42);
  const { left, right } = question;
  expect(question).toMatchObject({
    questionId: "addition-v1-42",
    seed: 42,
    left,
    right,
    expectedAnswer: left + right,
  });
  expect(left).toBeGreaterThanOrEqual(10);
  expect(left).toBeLessThanOrEqual(99);
  expect(right).toBeGreaterThanOrEqual(10);
  expect(right).toBeLessThanOrEqual(99);
  expect(question.prompt).toBe(`${left} + ${right}`);
  expect(createMathProbeQuestion(42)).toEqual(question);
});

test("math probe strictly separates empty, invalid, wrong, and correct answers", () => {
  expect(parseMathProbeAnswer("", 59)).toMatchObject({ classification: "empty", parsedAnswer: null });
  expect(parseMathProbeAnswer(" \n", 59)).toMatchObject({ classification: "empty", parsedAnswer: null });
  expect(parseMathProbeAnswer("59\n", 59)).toMatchObject({ classification: "correct", parsedAnswer: 59, trimmedNumeric: true });
  expect(parseMathProbeAnswer("  \n159 \t\n", 159)).toMatchObject({ classification: "correct", parsedAnswer: 159, trimmedNumeric: true });
  expect(parseMathProbeAnswer("答案是 59", 59)).toMatchObject({ classification: "format_invalid", parsedAnswer: null, trimmedNumeric: false });
  expect(parseMathProbeAnswer("58", 59)).toMatchObject({ classification: "wrong_number", parsedAnswer: 58 });
  expect(parseMathProbeAnswer("59", 59)).toMatchObject({ classification: "correct", parsedAnswer: 59 });
});

test("math probe cache prefix is deterministic, long enough, and process-independent", () => {
  const expected = createHash("sha256")
    .update(JSON.stringify({ system: MATH_PROBE_SYSTEM_PROMPT, history: PROBE_CACHE_HISTORY }))
    .digest("hex");
  expect(PROBE_CACHE_PREFIX_FINGERPRINT).toBe(expected);
  expect(PROBE_CACHE_HISTORY.length).toBeGreaterThanOrEqual(256);
  const totalCharacters = PROBE_CACHE_HISTORY.reduce((total, message) => total + message.content.length, 0);
  expect(totalCharacters).toBeGreaterThanOrEqual(6000);
});

test("math probe cache prefix contains no dynamic or sensitive markers", () => {
  const serialized = JSON.stringify({ system: MATH_PROBE_SYSTEM_PROMPT, history: PROBE_CACHE_HISTORY });
  expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u);
  expect(serialized).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu);
  expect(serialized).not.toMatch(/sk-[A-Za-z0-9_-]+/u);
  expect(serialized).not.toMatch(/account|api2business-probe|groupId|requestId/iu);
});

test("math probe cache prefix stays identical when only the question changes", () => {
  const responsesA = buildMathProbeRequestBody({ model: "gpt-6.1-sol", question: "12 + 34", transport: "responses" });
  const responsesB = buildMathProbeRequestBody({ model: "gpt-6.1-sol", question: "98 + 76", transport: "responses" });
  const chatA = buildMathProbeRequestBody({ model: "deepseek-flash", question: "12 + 34", transport: "chat_completions" });
  const chatB = buildMathProbeRequestBody({ model: "deepseek-flash", question: "98 + 76", transport: "chat_completions" });

  expect(responsesA.cachePrefixFingerprint).toBe(responsesB.cachePrefixFingerprint);
  expect(chatA.cachePrefixFingerprint).toBe(chatB.cachePrefixFingerprint);
  expect(responsesA.cachePrefixFingerprint).toBe(PROBE_CACHE_PREFIX_FINGERPRINT);
  expect(JSON.stringify((responsesA.body.input as unknown[]).slice(0, -1)))
    .toBe(JSON.stringify((responsesB.body.input as unknown[]).slice(0, -1)));
  expect(JSON.stringify((chatA.body.messages as unknown[]).slice(0, -1)))
    .toBe(JSON.stringify((chatB.body.messages as unknown[]).slice(0, -1)));
});

test("math probe request body appends the variable question after the fixed prefix", () => {
  const responses = buildMathProbeRequestBody({ model: "gpt-6.1-sol", question: "12 + 34", transport: "responses", reasoningEffort: "medium" });
  expect(responses.body).toMatchObject({
    model: "gpt-6.1-sol",
    instructions: MATH_PROBE_SYSTEM_PROMPT,
    reasoning: { effort: "medium" },
    max_output_tokens: 256,
    prompt_cache_key: PROBE_CACHE_ROUTING_KEY,
    prompt_cache_retention: "24h",
    store: false,
    stream: true,
  });
  expect((responses.body.input as Array<{ role: string; content: string }>).at(-1)).toEqual({ role: "user", content: "12 + 34" });

  const chat = buildMathProbeRequestBody({ model: "deepseek-flash", question: "12 + 34", transport: "chat_completions" });
  expect((chat.body.messages as Array<{ role: string; content: string }>).at(-1)).toEqual({ role: "user", content: "12 + 34" });
  expect((chat.body.messages as Array<{ role: string; content: string }>)[0]).toEqual({ role: "system", content: MATH_PROBE_SYSTEM_PROMPT });
});
