import { expect, test } from "bun:test";
import { createMathProbeQuestion, parseMathProbeAnswer } from "./probe-math";

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
  expect(parseMathProbeAnswer("59\n", 59)).toMatchObject({ classification: "format_invalid", parsedAnswer: 59, trimmedNumeric: true });
  expect(parseMathProbeAnswer("答案是 59", 59)).toMatchObject({ classification: "format_invalid", parsedAnswer: null, trimmedNumeric: false });
  expect(parseMathProbeAnswer("58", 59)).toMatchObject({ classification: "wrong_number", parsedAnswer: 58 });
  expect(parseMathProbeAnswer("59", 59)).toMatchObject({ classification: "correct", parsedAnswer: 59 });
});
