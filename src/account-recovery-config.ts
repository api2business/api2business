export interface AccountRecoveryConfig {
  priority: number;
  capacity: number;
  loadFactor: number | null;
  rateMultiplier: number | null;
  groupIds: number[];
  proxyId: number;
  autoPauseOnExpired: boolean | null;
  status: "active" | "inactive" | "error";
  schedulable: boolean;
}

function positiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`复活配置 ${field} 必须为正整数`);
  return number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`复活配置 ${field} 必须为非负整数`);
  return number;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`复活配置 ${field} 无效`);
  return number;
}

export function normalizeAccountRecoveryConfig(value: unknown): AccountRecoveryConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("复活配置缺失");
  const row = value as Record<string, unknown>;
  const status = String(row.status ?? "").toLowerCase();
  if (status !== "active" && status !== "inactive" && status !== "error") {
    throw new Error("复活配置 status 无效");
  }
  if (!Array.isArray(row.groupIds) || row.groupIds.length === 0) throw new Error("复活配置必须包含分组");
  const groupIds = [...new Set(row.groupIds.map((item) => positiveInteger(item, "groupIds")))].sort((a, b) => a - b);
  if (typeof row.schedulable !== "boolean") throw new Error("复活配置 schedulable 必须为布尔值");
  if (row.autoPauseOnExpired !== null && row.autoPauseOnExpired !== undefined && typeof row.autoPauseOnExpired !== "boolean") {
    throw new Error("复活配置 autoPauseOnExpired 必须为布尔值或 null");
  }
  return {
    priority: positiveInteger(row.priority, "priority"),
    capacity: positiveInteger(row.capacity, "capacity"),
    loadFactor: optionalNumber(row.loadFactor, "loadFactor"),
    rateMultiplier: optionalNumber(row.rateMultiplier, "rateMultiplier"),
    groupIds,
    proxyId: nonNegativeInteger(row.proxyId ?? 0, "proxyId"),
    autoPauseOnExpired: row.autoPauseOnExpired === undefined ? null : row.autoPauseOnExpired as boolean | null,
    status,
    schedulable: row.schedulable,
  };
}

export function recoveryConfigMismatches(value: unknown, expected: AccountRecoveryConfig): string[] {
  const actual = normalizeAccountRecoveryConfig(value);
  const mismatches: string[] = [];
  if (actual.priority !== expected.priority) mismatches.push("priority");
  if (actual.capacity !== expected.capacity) mismatches.push("capacity");
  if (actual.loadFactor !== expected.loadFactor) mismatches.push("loadFactor");
  if (actual.rateMultiplier !== expected.rateMultiplier) mismatches.push("rateMultiplier");
  if (actual.groupIds.join(",") !== expected.groupIds.join(",")) mismatches.push("groupIds");
  if (actual.proxyId !== expected.proxyId) mismatches.push("proxyId");
  if (actual.autoPauseOnExpired !== expected.autoPauseOnExpired) mismatches.push("autoPauseOnExpired");
  if (actual.status !== expected.status) mismatches.push("status");
  if (actual.schedulable !== expected.schedulable) mismatches.push("schedulable");
  return mismatches;
}
