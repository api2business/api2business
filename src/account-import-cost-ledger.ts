import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OAuthPlanType } from "./config";

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
  planType: OAuthPlanType | null;
  accountId: number;
  unitCostCny: number;
  amountCny: number;
}

interface AccountImportPlanTypeCorrectionEntry {
  version: 1;
  id: string;
  source: "account-import-plan-type-correction";
  occurredAt: string;
  accountId: number;
  originalEntryId: string;
  previousPlanType: OAuthPlanType | null;
  planType: OAuthPlanType;
}

type AccountImportLedgerEntry = AccountImportCostEntry | AccountImportPlanTypeCorrectionEntry;

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function entryId(accountId: number): string {
  return `account-import-${createHash("sha256").update(String(accountId)).digest("hex").slice(0, 16)}`;
}

function correctionEntryId(accountId: number, planType: OAuthPlanType): string {
  return `account-import-plan-type-correction-${createHash("sha256").update(`${accountId}:${planType}`).digest("hex").slice(0, 16)}`;
}

function isPlanType(value: unknown): value is OAuthPlanType {
  return value === "k12" || value === "plus" || value === "team" || value === "free";
}

export function accountImportBatchId(fingerprint: string): string {
  return `account-import-batch-${fingerprint.slice(0, 24)}`;
}

function parseEntry(value: unknown, line: number): AccountImportLedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`账号导入成本账本第 ${line} 行不是对象`);
  }
  const row = value as Record<string, unknown>;
  if (row.version === 1 && row.source === "account-import-plan-type-correction") {
    if (typeof row.id !== "string" || !row.id
      || typeof row.occurredAt !== "string"
      || !Number.isSafeInteger(row.accountId) || Number(row.accountId) < 1
      || typeof row.originalEntryId !== "string" || !row.originalEntryId
      || (row.previousPlanType !== null && !isPlanType(row.previousPlanType))
      || !isPlanType(row.planType)) {
      throw new Error(`账号导入成本账本第 ${line} 行类型更正字段无效`);
    }
    return row as unknown as AccountImportPlanTypeCorrectionEntry;
  }
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
  const planType = isPlanType(row.planType) ? row.planType : null;
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
  const ledger = content.trimEnd().split("\n").map((line, index) => {
    try {
      return parseEntry(JSON.parse(line), index + 1);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`账号导入成本账本第 ${index + 1} 行 JSON 无效`);
      throw error;
    }
  });
  const costs = ledger.filter((entry): entry is AccountImportCostEntry => entry.source === "account-import")
    .map((entry) => ({ ...entry }));
  const byAccount = new Map(costs.map((entry) => [entry.accountId, entry]));
  for (const correction of ledger.filter((entry): entry is AccountImportPlanTypeCorrectionEntry => entry.source === "account-import-plan-type-correction")) {
    const cost = byAccount.get(correction.accountId);
    if (!cost || cost.id !== correction.originalEntryId) {
      throw new Error(`账号 ${correction.accountId} 的类型更正找不到原采购记录`);
    }
    if (cost.planType !== correction.previousPlanType) {
      throw new Error(`账号 ${correction.accountId} 的类型更正前置类型不一致`);
    }
    cost.planType = correction.planType;
  }
  return costs;
}

export function recordAccountImportPlanTypeCorrections(input: {
  path: string;
  accountIds: number[];
  planType: OAuthPlanType;
  occurredAt?: string;
}) {
  const accountIds = [...new Set(input.accountIds)].sort((left, right) => left - right);
  if (accountIds.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error("类型更正账号 ID 必须为正整数");
  const costs = readAccountImportCosts(input.path);
  const byAccount = new Map(costs.map((entry) => [entry.accountId, entry]));
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const entries: AccountImportPlanTypeCorrectionEntry[] = accountIds.flatMap((accountId) => {
    const cost = byAccount.get(accountId);
    if (!cost || cost.planType === input.planType) return [];
    return [{
      version: 1,
      id: correctionEntryId(accountId, input.planType),
      source: "account-import-plan-type-correction",
      occurredAt,
      accountId,
      originalEntryId: cost.id,
      previousPlanType: cost.planType,
      planType: input.planType,
    }];
  });
  if (entries.length > 0) {
    mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
    appendFileSync(input.path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return {
    requestedAccountIds: accountIds,
    correctedAccountIds: entries.map((entry) => entry.accountId),
    skippedAccountIds: accountIds.filter((accountId) => !entries.some((entry) => entry.accountId === accountId)),
    correctedCount: entries.length,
  };
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
  planType?: OAuthPlanType;
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
