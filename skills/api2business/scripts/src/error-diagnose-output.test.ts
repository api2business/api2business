import { expect, test } from "bun:test";
import { emitErrorDiagnosis } from "./error-diagnose-output";

test("compact diagnosis prints actual switch count and failover outcome", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    emitErrorDiagnosis({
      summary: {
        sampledErrorRows: 2,
        distinctRequests: 2,
        customerVisibleRequests: 2,
        recoveredRequests: 0,
        failoverTriggeredRequests: 1,
        failoverRecoveredRequests: 0,
        failoverFailedRequests: 1,
        failoverSwitches: 2,
      },
      signatures: [],
      chains: [
        {
          customerVisible: true,
          recovered: false,
          switchCount: 2,
          failoverOutcome: "failed",
          failoverFailureReason: "final_error_after_switch",
          finalStatusCode: 502,
          requestId: "request-switched",
          finalSignature: "502:upstream:upstream_error:-:upstream_502",
        },
        {
          customerVisible: true,
          recovered: false,
          switchCount: 0,
          failoverOutcome: "not_triggered",
          failoverFailureReason: null,
          finalStatusCode: 502,
          requestId: "request-not-triggered",
          finalSignature: "502:upstream:upstream_error:-:upstream_502",
        },
      ],
    }, false);
  } finally {
    console.log = original;
  }

  expect(lines[0]).toContain("switches=2");
  expect(lines.join("\n")).toContain("request-switched");
  expect(lines.join("\n")).toContain("final_error_after_switch");
  expect(lines.join("\n")).toContain("request-not-triggered");
  expect(lines.join("\n")).toContain("not_triggered");
});
