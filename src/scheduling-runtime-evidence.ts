import type { Sub2ApiClient } from "./sub2api-client";

const fields = new Set([
  "account_id", "group_id", "id", "total_accounts", "available_count", "rate_limit_count",
  "error_count", "is_available", "schedulable", "current_in_use", "max_capacity",
  "waiting_in_queue", "concurrency", "current_concurrency", "capacity", "in_use", "load_factor",
]);
const containers = new Set(["account", "accounts", "group", "groups", "items"]);

// Native operational responses can grow new fields; never forward credentials or arbitrary strings.
export function projectSchedulingRuntime(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectSchedulingRuntime);
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (fields.has(key) && (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)) || item === null)) return [[key, item]];
    if (containers.has(key) || /^\d+$/.test(key)) return [[key, projectSchedulingRuntime(item)]];
    return [];
  }));
}

export async function collectSchedulingRuntime(client: Pick<Sub2ApiClient, "getOpsAccountAvailability" | "getOpsConcurrency" | "request">, group: unknown, platform: unknown) {
  const groupId = Number(group);
  if (!Number.isSafeInteger(groupId) || groupId < 1 || !["openai", "anthropic", "grok"].includes(String(platform))) {
    throw new Error("runtime evidence requires a positive group ID and platform openai|anthropic|grok");
  }
  const startedAt = new Date().toISOString();
  async function read(source: string, query: () => Promise<unknown>, project = projectSchedulingRuntime) {
    try { return { source, status: "available", data: project(await query()) }; }
    catch (error) {
      const text = error instanceof Error ? error.message : "";
      return { source, status: "unavailable", httpStatus: Number(text.match(/HTTP (\d{3})/)?.[1]) || null, data: null };
    }
  }
  const [availability, concurrency, nativeVersion] = await Promise.all([
    read("Sub2API /admin/ops/account-availability", () => client.getOpsAccountAvailability(groupId, String(platform))),
    read("Sub2API /admin/ops/concurrency", () => client.getOpsConcurrency(groupId, String(platform))),
    read("Sub2API /admin/system/version", () => client.request("/admin/system/version"), (value) => {
      const version = value && typeof value === "object" ? (value as { version?: unknown }).version : null;
      if (typeof version !== "string" || !/^v?\d[\w.+-]{0,127}$/.test(version)) throw new Error("Native version unavailable");
      return { version };
    }),
  ]);
  return { ok: true, mode: "native-scheduling-runtime", groupId, platform, startedAt, sampledAt: new Date().toISOString(),
    complete: availability.status === "available" && concurrency.status === "available", availability, concurrency, nativeVersion,
    limitations: ["当前时点证据，不是历史窗口；不提供会话绑定或单次选路原因。", "账号group_id及分组汇总保留原生语义，可能按成员关系聚合；不能当作请求分组归因或指定模型可用性。"], valuesPrinted: false };
}
