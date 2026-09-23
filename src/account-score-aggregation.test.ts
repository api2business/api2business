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

test("group merge keeps the policy score instead of replacing it", () => {
  const [row] = mergeAccountScores([
    {
      accountId: 478,
      accountName: "https://rapidapi.cc pro",
      platform: "openai",
      accountType: "apikey",
      groupId: 2,
      groupName: "自用",
      status: "active",
      currentAvailable: true,
      currentlyAvailable: true,
      score: 72.3,
      grade: "C",
      scoreComponents: { weights: { reliability: 48, failover: 10, latency: 37 } },
    },
    {
      accountId: 478,
      accountName: "https://rapidapi.cc pro",
      platform: "openai",
      accountType: "apikey",
      groupId: 3,
      groupName: "混合池",
      status: "active",
      currentAvailable: true,
      currentlyAvailable: true,
      score: 81.3,
      grade: "B",
      scoreComponents: { weights: { reliability: 60, latency: 25 } },
    },
  ]);

  expect(row).toMatchObject({
    score: 72.3,
    grade: "C",
    groupNames: ["自用", "混合池"],
    scoreComponents: { weights: { reliability: 48, failover: 10, latency: 37 } },
  });
});
