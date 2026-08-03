import { expect, test } from "bun:test";
import { normalizeManualPriorityAssignments } from "./manual-priority-plan";

test("normalizes manual priority assignments by numeric account ID", () => {
  expect(normalizeManualPriorityAssignments({ "64": 299, "51": 299, "52": 300 })).toEqual({
    "51": 299,
    "52": 300,
    "64": 299,
  });
});

test("rejects empty or malformed manual priority assignments", () => {
  expect(() => normalizeManualPriorityAssignments({})).toThrow("at least one account");
  expect(() => normalizeManualPriorityAssignments({ "01": 299 })).toThrow("invalid manual priority account ID");
  expect(() => normalizeManualPriorityAssignments({ "51": 0 })).toThrow("invalid manual priority");
});
