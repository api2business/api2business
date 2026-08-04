import { expect, test } from "bun:test";
import { TemporalSubmissionError, temporalErrorDetails } from "./temporal-client";

test("projects a nested Temporal submission error without losing its cause", () => {
  const cause = Object.assign(new Error("namespace application is unavailable"), { code: "UNAVAILABLE" });
  const error = Object.assign(new Error("Failed to start Workflow", { cause }), { code: "SERVICE_ERROR" });

  expect(temporalErrorDetails(error)).toEqual({
    name: "Error",
    code: "SERVICE_ERROR",
    message: "Failed to start Workflow",
    cause: {
      name: "Error",
      code: "UNAVAILABLE",
      message: "namespace application is unavailable",
    },
  });
  expect(new TemporalSubmissionError(error).message).toBe(
    "Temporal 作业提交失败：namespace application is unavailable",
  );
});
