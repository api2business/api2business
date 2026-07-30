import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AccountLifecycleSettlement {
  version: 1;
  id: string;
  source: "oauth-lifecycle-settlement";
  occurredAt: string;
  acquisitionDay: string;
  planType: "k12" | "plus";
  accountIds: number[];
  accountCount: number;
  grossAcquisitionCostCny: number;
  requestCount: number;
  tokenCount: number;
  apiAmountUsd: number;
  grossCnyPerApiUsd: number | null;
  detectionJobId: string;
  detectionFingerprint: string;
}

function fingerprint(input: Omit<AccountLifecycleSettlement, "version" | "id" | "source" | "occurredAt">): string {
  return createHash("sha256").update(JSON.stringify({
    acquisitionDay: input.acquisitionDay,
    planType: input.planType,
    accountIds: input.accountIds,
  })).digest("hex");
}

export function readLifecycleSettlements(path: string): AccountLifecycleSettlement[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8").trim();
  if (!content) return [];
  return content.split("\n").map((line, index) => {
    const row = JSON.parse(line) as AccountLifecycleSettlement;
    if (row.version !== 1 || row.source !== "oauth-lifecycle-settlement" || !Array.isArray(row.accountIds)) {
      throw new Error(`OAuth 生命周期结算账本第 ${index + 1} 行字段无效`);
    }
    return row;
  });
}

export function recordLifecycleSettlement(
  path: string,
  input: Omit<AccountLifecycleSettlement, "version" | "id" | "source" | "occurredAt">,
): { entry: AccountLifecycleSettlement; mutation: boolean } {
  const digest = fingerprint(input);
  const id = `oauth-lifecycle-${digest.slice(0, 16)}`;
  const existing = readLifecycleSettlements(path).find((entry) => entry.id === id);
  if (existing) return { entry: existing, mutation: false };
  const entry: AccountLifecycleSettlement = {
    version: 1,
    id,
    source: "oauth-lifecycle-settlement",
    occurredAt: new Date().toISOString(),
    ...input,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  return { entry, mutation: true };
}
