import { expect, test } from "bun:test";
import { collectRecentCallScores } from "./account-score-recent-calls";
import type { Sub2ApiClient, Sub2ApiUsageRow } from "./sub2api-client";

test("current account state is displayed but does not affect recent-call score", async () => {
  const usage: Sub2ApiUsageRow[] = Array.from({ length: 20 }, (_, index) => ({
    id: index + 1,
    account_id: 9,
    group_id: 2,
    model: "gpt-test",
    stream: true,
    input_tokens: 10,
    output_tokens: 10,
    actual_cost: 0.01,
    duration_ms: 10_000,
    first_token_ms: 5_000,
    created_at: new Date(Date.UTC(2026, 6, 23, 0, 0, index)).toISOString(),
  }));
  const client = {
    async listGroups() {
      return [{ id: 2, name: "pool", platform: "openai", status: "active" }];
    },
    async listGroupAccounts() {
      return [{ id: 9, name: "empty-balance", platform: "openai", status: "error", schedulable: false, priority: 5 }];
    },
    async getOpsAccountAvailability() {
      return {
        account: {
          "9": {
            account_id: 9,
            group_id: 2,
            is_available: false,
            status: "error",
            error_message: "Insufficient account balance",
          },
        },
      };
    },
    async listRecentAccountUsage() {
      return { rows: usage, requestCount: 1 };
    },
    async listRecentAccountRequestErrors() {
      return { rows: [], requestCount: 1 };
    },
  } as unknown as Sub2ApiClient;

  const result = await collectRecentCallScores(client, 500);
  const row = result.accounts[0]!;
  expect(row.score).toBe(100);
  expect(row.grade).toBe("A");
  expect(row.currentAvailable).toBe(false);
  expect(row.currentError).toBe("Insufficient account balance");
  expect(row.currentStateScoreImpact).toBe("none");
  expect(row.status).toBe("error");
});
