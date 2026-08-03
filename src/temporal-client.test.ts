import { expect, test } from "bun:test";
import { TemporalSubmissionError, temporalErrorDetails } from "./temporal-client";

test("projects a nested Temporal submission error without losing its cause", () => {
  const cause = Object.assign(new Error("namespace unidesk is unavailable"), { code: "UNAVAILABLE" });
  const error = Object.assign(new Error("Failed to start Workflow", { cause }), { code: "SERVICE_ERROR" });

  expect(temporalErrorDetails(error)).toEqual({
    name: "Error",
    code: "SERVICE_ERROR",
    message: "Failed to start Workflow",
    cause: {
      name: "Error",
      code: "UNAVAILABLE",
      message: "namespace unidesk is unavailable",
    },
  });
  expect(new TemporalSubmissionError(error).message).toBe(
    "Temporal 作业提交失败：namespace unidesk is unavailable",
  );
});
