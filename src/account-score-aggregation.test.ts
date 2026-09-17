import { expect, test } from "bun:test";
import { mergeAccountScores } from "./account-score-aggregation";

test("aggregated availability uses the canonical field and keeps both display aliases consistent", () => {
  const [row] = mergeAccountScores([{
    accountId: 37,
    accountName: "https://example.test plus 0.1",
    groupId: 2,
    groupName: "pool",
    status: "active",
    currentAvailable: false,
    currentlyAvailable: true,
    successRequests: 10,
    failureRequests: 0,
    firstTokenSamples: 5,
    streamSuccessRequests: 5,
    ttftP95Ms: 1000,
  }]);

  expect(row).toMatchObject({ currentAvailable: false, currentlyAvailable: false });
});
