import { describe, expect, test } from "bun:test";
import { matchExternalCutoff } from "./external-cutoff-match";

const rules = [{
  statusCodes: [499, 502, 503, 504, 522, 524],
  keywords: ["stream_read_error", "upstream stream disconnected", "unexpected eof"],
  description: "断流",
}];

describe("external cutoff matching", () => {
  test("matches a customer-visible upstream stream failure", () => {
    expect(matchExternalCutoff({ accountId: 37, statusCode: 502, phase: "upstream", text: "upstream stream disconnected" }, rules)).toMatchObject({ matched: true, keyword: "upstream stream disconnected", ruleIndex: 0 });
  });

  test("does not match an unrelated gateway error", () => {
    expect(matchExternalCutoff({ accountId: 37, statusCode: 502, phase: "upstream", text: "bad gateway" }, rules).matched).toBe(false);
  });

  test("matches structured upstream unavailable marker", () => {
    expect(matchExternalCutoff({ accountId: 37, statusCode: 502, phase: "upstream", text: '{"code":"upstream_unavailable","type":"upstream_error"}' }, [{
      statusCodes: [502], keywords: ["upstream_unavailable"], description: "断流",
    }])).toMatchObject({ matched: true, keyword: "upstream_unavailable" });
  });
});
