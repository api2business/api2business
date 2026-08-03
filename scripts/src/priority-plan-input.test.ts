import { expect, test } from "bun:test";
import { parseManualPriorityAssignments } from "./priority-plan-input";

test("parses multiple manual priority assignments", () => {
  expect(parseManualPriorityAssignments("64:299, 51:299,52:300")).toEqual({
    "51": 299,
    "52": 300,
    "64": 299,
  });
});

test("rejects duplicate or malformed manual priority CLI entries", () => {
  expect(() => parseManualPriorityAssignments("51:299,51:300")).toThrow("duplicate --priorities account ID");
  expect(() => parseManualPriorityAssignments("51=299")).toThrow("expected ACCOUNT_ID:PRIORITY");
  expect(() => parseManualPriorityAssignments("")).toThrow("expected ACCOUNT_ID:PRIORITY");
});
