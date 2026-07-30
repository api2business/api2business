import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AccountImportCostEntry {
  version: 1;
  id: string;
  source: "account-import";
  currency: "CNY";
  occurredAt: string;
  occurredOn: string;
  period: string;
  fingerprint: string;
  batchId: string;
  planType: "k12" | "plus" | null;
  accountId: number;
  unitCostCny: number;
  amountCny: number;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function entryId(accountId: number): string {
  return `account-import-${createHash("sha256").update(String(accountId)).digest("hex").slice(0, 16)}`;
}

export function accountImportBatchId(fingerprint: string): string {
  return `account-import-batch-${fingerprint.slice(0, 24)}`;
}

function parseEntry(value: unknown, line: number): AccountImportCostEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`账号导入成本账本第 ${line} 行不是对象`);
  }
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.source !== "account-import" || row.currency !== "CNY"
    || typeof row.id !== "string" || !row.id
    || typeof row.occurredAt !== "string" || typeof row.occurredOn !== "string" || typeof row.period !== "string"
    || typeof row.fingerprint !== "string" || !row.fingerprint
    || !Number.isSafeInteger(row.accountId) || Number(row.accountId) < 1
    || !Number.isFinite(row.unitCostCny) || Number(row.unitCostCny) <= 0
    || !Number.isFinite(row.amountCny) || Number(row.amountCny) <= 0) {
    throw new Error(`账号导入成本账本第 ${line} 行字段无效`);
  }
  const fingerprint = row.fingerprint as string;
  const planType = row.planType === "k12" || row.planType === "plus" ? row.planType : null;
  return {
    ...row,
    batchId: typeof row.batchId === "string" && row.batchId ? row.batchId : accountImportBatchId(fingerprint),
    planType,
  } as unknown as AccountImportCostEntry;
}

export function readAccountImportCosts(path: string): AccountImportCostEntry[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  if (!content.trim()) return [];
  return content.trimEnd().split("\n").map((line, index) => {
    try {
      return parseEntry(JSON.parse(line), index + 1);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`账号导入成本账本第 ${index + 1} 行 JSON 无效`);
      throw error;
    }
  });
}

export function summarizeAccountImportCosts(path: string, input: { day?: string; period?: string }) {
  const entries = readAccountImportCosts(path).filter((entry) => input.day ? entry.occurredOn === input.day : entry.period === input.period);
  return {
    currency: "CNY" as const,
    entryCount: entries.length,
    totalCostCny: money(entries.reduce((total, entry) => total + entry.amountCny, 0)),
  };
}

export function recordAccountImportCosts(input: {
  path: string;
  fingerprint: string;
  accountIds: number[];
  unitCostCny: number;
  planType?: "k12" | "plus";
  occurredAt?: string;
  occurredOn: string;
}) {
  if (!Number.isFinite(input.unitCostCny) || input.unitCostCny <= 0) throw new Error("账号单价必须为正数人民币");
  const accountIds = [...new Set(input.accountIds)].sort((a, b) => a - b);
  if (accountIds.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error("记账账号 ID 必须为正整数");
  const existing = readAccountImportCosts(input.path);
  const existingIds = new Set(existing.map((entry) => entry.accountId));
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const occurredOn = input.occurredOn;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(occurredOn)) throw new Error("记账日期必须使用 YYYY-MM-DD");
  const unitCostCny = money(input.unitCostCny);
  const entries: AccountImportCostEntry[] = accountIds.filter((id) => !existingIds.has(id)).map((accountId) => ({
    version: 1,
    id: entryId(accountId),
    source: "account-import",
    currency: "CNY",
    occurredAt,
    occurredOn,
    period: occurredOn.slice(0, 7),
    fingerprint: input.fingerprint,
    batchId: accountImportBatchId(input.fingerprint),
    planType: input.planType ?? null,
    accountId,
    unitCostCny,
    amountCny: unitCostCny,
  }));
  if (entries.length > 0) {
    mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
    appendFileSync(input.path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return {
    currency: "CNY" as const,
    unitCostCny,
    requestedAccountIds: accountIds,
    recordedAccountIds: entries.map((entry) => entry.accountId),
    skippedAccountIds: accountIds.filter((id) => existingIds.has(id)),
    recordedCount: entries.length,
    totalCostCny: money(entries.length * unitCostCny),
    pathPrinted: false,
  };
}
