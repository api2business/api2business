import type { AppConfig } from "./config";
import type { Sub2ApiClient } from "./sub2api-client";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import { isAudioRequest } from "./scoring-error-policy";

type Row = Record<string, unknown>;
export interface GatewayServicePolicy {
  denyAudio: boolean;
  requiredModelsByPlatform: Record<string, string[]>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function record(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function allowedModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter((model) => model && !model.includes("*") && !isAudioRequest([model])))].sort();
}

// 只读目录只投影模型名，不读取账号凭据；原生 PUT 只写分组准入字段。
export async function reconcileGatewayServicePolicy(
  client: Sub2ApiClient, reads: Sub2ApiReadClient, config: AppConfig, confirm: boolean,
): Promise<Record<string, unknown>> {
  const policy = config.sub2api.gatewayServicePolicy;
  if (!policy?.denyAudio) return { ok: true, skipped: true, reason: "gatewayServicePolicy.denyAudio is not enabled", mutation: false };
  const catalog = await reads.query<{ platform: string; models: string[] }>({
    key: "gateway.service-policy.models", kind: "gateway.service-policy.models", priority: "manual", cacheMode: "bypass-cache",
    sql: `SELECT platform, array_agg(DISTINCT model ORDER BY model) AS models FROM (
      SELECT a.platform, jsonb_object_keys(CASE WHEN jsonb_typeof(a.credentials->'model_mapping')='object'
        THEN a.credentials->'model_mapping' ELSE '{}'::jsonb END) AS model
      FROM accounts a WHERE a.deleted_at IS NULL
    ) catalog WHERE model IS NOT NULL GROUP BY platform`, parameters: [],
  });
  const groups = await client.request<Row[]>("/admin/groups/all");
  const byPlatform = new Map<string, string[]>();
  for (const item of catalog.rows) byPlatform.set(item.platform, strings(item.models));
  for (const group of groups) {
    const platform = String(group.platform);
    byPlatform.set(platform, [...(byPlatform.get(platform) ?? []), ...strings(record(group.model_allowlist).models)]);
  }
  const plan = groups.map((group) => {
    const before = record(group.model_allowlist);
    const models = allowedModels([...(byPlatform.get(String(group.platform)) ?? []), ...(policy.requiredModelsByPlatform[String(group.platform)] ?? [])]);
    if (!models.length) throw new Error(`group ${group.id} has no evidenced non-audio model catalog`);
    return { groupId: Number(group.id), platform: String(group.platform), models,
      changed: before.enabled !== true || JSON.stringify(strings(before.models).slice().sort()) !== JSON.stringify(models) || group.allow_live === true };
  });
  let updated = 0;
  if (confirm) for (const item of plan.filter((item) => item.changed)) {
    await client.mutate("PUT", `/admin/groups/${item.groupId}`, { model_allowlist: { enabled: true, models: item.models }, allow_live: false });
    const saved = await client.request<Row>(`/admin/groups/${item.groupId}`);
    const actual = record(saved.model_allowlist);
    if (actual.enabled !== true || saved.allow_live !== false
      || JSON.stringify(strings(actual.models).slice().sort()) !== JSON.stringify(item.models)) throw new Error(`group ${item.groupId} service policy readback mismatch`);
    updated += 1;
  }
  return { ok: true, mutation: confirm, denyAudio: true, groupCount: plan.length, changedCount: plan.filter((item) => item.changed).length,
    updated, groups: plan.map((item) => ({ groupId: item.groupId, platform: item.platform, modelCount: item.models.length, changed: item.changed })), valuesPrinted: false };
}
