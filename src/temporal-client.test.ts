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

test("marks an expired workflow lookup as an explicit terminal state", async () => {
  const source = await Bun.file(new URL("./temporal-client.ts", import.meta.url)).text();
  const status = source.slice(source.indexOf("  async status(workflowId: string)"));
  expect(status).toContain('error.name === "WorkflowNotFoundError"');
  expect(status).toContain('state: "not_found"');
  expect(status).toContain("Temporal workflow 已不在保留期内");
});
