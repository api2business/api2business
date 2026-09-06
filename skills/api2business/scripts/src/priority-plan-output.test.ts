import { expect, test } from "bun:test";
import { renderPriorityPlanLines } from "./priority-plan-output";

test("priority plan text includes review evidence and exact priorities", () => {
  const lines = renderPriorityPlanLines({
    recentCallLimit: 1000,
    eligibleCount: 2,
    changedCount: 2,
    policy: { procurementAdvice: { statusAlertLimit: 20 } },
    changes: [
      {
        accountId: 8,
        accountName: "slow.example pro 0.2",
        observedAttempts: 1000,
        failureRate: 0.012,
        failoverRate: 0.034,
        ttftP95Ms: 24117,
        evidenceScore: 88,
        score: 86.6,
        costRateCnyPerApiUsd: 0.2,
        combinedScore: 69.28,
        beforePriority: 126,
        desiredPriority: 288,
        change: "update",
      },
    ],
    priorities: { "8": 288, "2": 111 },
    procurementAdvice: {
      summary: {
        redundancyStatus: "diversified",
        stableSupplierCount: 4,
        largestSupplierShare: 0.25,
        unavailableAccountCount: 0,
        billingDepletedAccountCount: 0,
      },
      statusAlerts: [],
      recommendations: [],
    },
    apply: {
      through: "api2business-priority-plan-confirm",
      target: "example-runtime",
      writeMode: "backend-api-paced",
      batchSize: 3,
      verification: "native-api-read-broker",
    },
  });

  expect(lines.join("\n")).toContain("N  FAIL%  SWITCH%  TTFT_P95  EVID  QUALITY   COST  VALUE");
  expect(lines.join("\n")).toContain("1.2%");
  expect(lines.join("\n")).toContain("3.4%");
  expect(lines.join("\n")).toContain("24117ms");
  expect(lines.join("\n")).toContain("0.200");
  expect(lines.join("\n")).toContain('"target":"example-runtime"');
  expect(lines).toContain('PRIORITIES_JSON {"2":111,"8":288}');
});
