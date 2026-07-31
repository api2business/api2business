import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface UpstreamRechargeCostEntry {
  version: 1;
  id: string;
  source: "upstream-recharge";
  currency: "CNY";
  occurredAt: string;
  occurredOn: string;
  period: string;
  operationId: string;
  accountId: number;
  accountName: string;
  baseUrl: string;
  suffix: string;
  rateCnyPerApiUsd: number;
  amountCny: number;
  description: string;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseEntry(value: unknown, line: number): UpstreamRechargeCostEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`上游充值账本第 ${line} 行不是对象`);
  }
  const row = value as Record<string, unknown>;
  const requiredStrings = ["id", "occurredAt", "occurredOn", "period", "operationId", "accountName", "baseUrl", "suffix", "description"];
  if (row.version !== 1 || row.source !== "upstream-recharge" || row.currency !== "CNY"
    || requiredStrings.some((key) => typeof row[key] !== "string" || !(row[key] as string).trim())
    || !Number.isSafeInteger(row.accountId) || Number(row.accountId) < 1
    || !Number.isFinite(row.rateCnyPerApiUsd) || Number(row.rateCnyPerApiUsd) <= 0
    || !Number.isFinite(row.amountCny) || Number(row.amountCny) <= 0
    || Math.abs(Math.round(Number(row.amountCny) * 100) - Number(row.amountCny) * 100) > 1e-8
    || !/^\d{4}-\d{2}-\d{2}$/u.test(String(row.occurredOn))) {
    throw new Error(`上游充值账本第 ${line} 行字段无效`);
  }
  return {
    ...row,
    rateCnyPerApiUsd: Number(row.rateCnyPerApiUsd),
    amountCny: money(Number(row.amountCny)),
  } as unknown as UpstreamRechargeCostEntry;
}

export function readUpstreamRechargeCosts(path: string): UpstreamRechargeCostEntry[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  if (!content.trim()) return [];
  return content.trimEnd().split("\n").map((line, index) => {
    try {
      return parseEntry(JSON.parse(line), index + 1);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`上游充值账本第 ${index + 1} 行 JSON 无效`);
      throw error;
    }
  });
}

function entryId(operationId: string): string {
  return `upstream-recharge-${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`;
}

export function recordUpstreamRechargeCost(input: {
  path: string;
  operationId: string;
  occurredAt?: string;
  occurredOn: string;
  accountId: number;
  accountName: string;
  baseUrl: string;
  suffix: string;
  rateCnyPerApiUsd: number;
  amountCny: number;
  description?: string;
}): { currency: "CNY"; mutation: boolean; entry: UpstreamRechargeCostEntry; pathPrinted: false } {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.occurredOn)) throw new Error("充值记账日期必须使用 YYYY-MM-DD");
  if (!Number.isSafeInteger(input.accountId) || input.accountId < 1) throw new Error("充值记账账号 ID 无效");
  if (!Number.isFinite(input.amountCny) || input.amountCny <= 0
    || Math.abs(Math.round(input.amountCny * 100) - input.amountCny * 100) > 1e-8) {
    throw new Error("充值金额必须为正数人民币且最多两位小数");
  }
  if (!Number.isFinite(input.rateCnyPerApiUsd) || input.rateCnyPerApiUsd <= 0) throw new Error("费率必须为正数");
  const operationId = input.operationId.trim();
  if (!operationId || operationId.length > 160 || /[\r\n]/u.test(operationId)) throw new Error("充值幂等键无效");
  const existing = readUpstreamRechargeCosts(input.path).find((entry) => entry.operationId === operationId);
  const amountCny = money(input.amountCny);
  if (existing) {
    if (existing.accountId !== input.accountId || Math.abs(existing.amountCny - amountCny) > 1e-8) {
      throw new Error("充值幂等键已用于其他账号或金额");
    }
    return { currency: "CNY", mutation: false, entry: existing, pathPrinted: false };
  }
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const entry: UpstreamRechargeCostEntry = {
    version: 1,
    id: entryId(operationId),
    source: "upstream-recharge",
    currency: "CNY",
    occurredAt,
    occurredOn: input.occurredOn,
    period: input.occurredOn.slice(0, 7),
    operationId,
    accountId: input.accountId,
    accountName: input.accountName,
    baseUrl: input.baseUrl,
    suffix: input.suffix,
    rateCnyPerApiUsd: input.rateCnyPerApiUsd,
    amountCny,
    description: input.description?.trim() || `上游 ${input.accountName} 充值成本`,
  };
  const directory = dirname(input.path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  appendFileSync(input.path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(input.path, 0o600);
  return { currency: "CNY", mutation: true, entry, pathPrinted: false };
}

export function rechargeTotalsByAccount(entries: UpstreamRechargeCostEntry[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const entry of entries) totals.set(entry.accountId, money((totals.get(entry.accountId) ?? 0) + entry.amountCny));
  return totals;
}
