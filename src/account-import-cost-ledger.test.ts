import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAccountImportCosts, recordAccountImportCosts } from "./account-import-cost-ledger";

test("records CNY account costs once per stable account id", () => {
  const directory = mkdtempSync(join(tmpdir(), "apistate-cost-ledger-"));
  const path = join(directory, "costs.jsonl");
  try {
    const first = recordAccountImportCosts({
      path,
      fingerprint: "abc123",
      accountIds: [102, 101],
      unitCostCny: 18.8,
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
      expect.objectContaining({ accountId: 101, amountCny: 18.8, currency: "CNY", occurredOn: "2026-07-31", period: "2026-07" }),
      expect.objectContaining({ accountId: 102, amountCny: 18.8, currency: "CNY", occurredOn: "2026-07-31", period: "2026-07" }),
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
