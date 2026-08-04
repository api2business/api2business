import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountImportBatchId, readAccountImportCosts, recordAccountImportCosts, recordAccountImportPlanTypeCorrections } from "./account-import-cost-ledger";

test("records CNY account costs once per stable account id", () => {
  const directory = mkdtempSync(join(tmpdir(), "api2business-cost-ledger-"));
  const path = join(directory, "costs.jsonl");
  try {
    const first = recordAccountImportCosts({
      path,
      fingerprint: "abc123",
      accountIds: [102, 101],
      unitCostCny: 18.8,
      planType: "plus",
      occurredAt: "2026-07-30T16:30:00.000Z",
      occurredOn: "2026-07-31",
    });
    const repeated = recordAccountImportCosts({
      path,
      fingerprint: "abc123",
      accountIds: [101, 102],
      unitCostCny: 18.8,
      occurredOn: "2026-07-31",
    });

    expect(first).toMatchObject({ currency: "CNY", recordedAccountIds: [101, 102], recordedCount: 2, totalCostCny: 37.6 });
    expect(repeated).toMatchObject({ recordedCount: 0, skippedAccountIds: [101, 102], totalCostCny: 0 });
    expect(readAccountImportCosts(path)).toEqual([
      expect.objectContaining({ accountId: 101, amountCny: 18.8, currency: "CNY", occurredOn: "2026-07-31", period: "2026-07", batchId: accountImportBatchId("abc123"), planType: "plus" }),
      expect.objectContaining({ accountId: 102, amountCny: 18.8, currency: "CNY", occurredOn: "2026-07-31", period: "2026-07", batchId: accountImportBatchId("abc123"), planType: "plus" }),
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves Free as an import label in the CNY ledger", () => {
  const directory = mkdtempSync(join(tmpdir(), "api2business-cost-ledger-free-"));
  const path = join(directory, "costs.jsonl");
  try {
    recordAccountImportCosts({
      path,
      fingerprint: "free-batch",
      accountIds: [103],
      unitCostCny: 0.5,
      planType: "free",
      occurredOn: "2026-07-31",
    });
    expect(readAccountImportCosts(path)).toEqual([
      expect.objectContaining({ accountId: 103, planType: "free", unitCostCny: 0.5, amountCny: 0.5 }),
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves Team as an import label in the CNY ledger", () => {
  const directory = mkdtempSync(join(tmpdir(), "api2business-cost-ledger-team-"));
  const path = join(directory, "costs.jsonl");
  try {
    recordAccountImportCosts({
      path,
      fingerprint: "team-batch",
      accountIds: [104],
      unitCostCny: 20,
      planType: "team",
      occurredOn: "2026-07-31",
    });
    expect(readAccountImportCosts(path)).toEqual([
      expect.objectContaining({ accountId: 104, planType: "team", unitCostCny: 20, amountCny: 20 }),
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrects an imported plan type without changing acquisition cost", () => {
  const directory = mkdtempSync(join(tmpdir(), "api2business-cost-ledger-correction-"));
  const path = join(directory, "costs.jsonl");
  try {
    recordAccountImportCosts({
      path,
      fingerprint: "mistyped-free-batch",
      accountIds: [377, 378, 379],
      unitCostCny: 0.01,
      planType: "free",
      occurredOn: "2026-08-03",
    });
    const correction = recordAccountImportPlanTypeCorrections({
      path,
      accountIds: [377, 378, 379],
      planType: "k12",
      occurredAt: "2026-08-03T12:00:00.000Z",
    });
    const repeated = recordAccountImportPlanTypeCorrections({ path, accountIds: [377, 378, 379], planType: "k12" });

    expect(correction).toMatchObject({ correctedAccountIds: [377, 378, 379], correctedCount: 3 });
    expect(repeated).toMatchObject({ correctedCount: 0, skippedAccountIds: [377, 378, 379] });
    expect(readAccountImportCosts(path)).toEqual([
      expect.objectContaining({ accountId: 377, planType: "k12", amountCny: 0.01 }),
      expect.objectContaining({ accountId: 378, planType: "k12", amountCny: 0.01 }),
      expect.objectContaining({ accountId: 379, planType: "k12", amountCny: 0.01 }),
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
