import type { AppConfig } from "./config";
import type { ProbeIsolationService } from "./probe-isolation";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import type { Sub2ApiRuntimeService } from "./sub2api-runtime-service";
import type { OperationsService } from "./operations-service";

type Row = Record<string, unknown>;
type Platform = "openai" | "anthropic" | "grok";

function platform(value: unknown): Platform {
  if (value === "openai" || value === "anthropic" || value === "grok") return value;
  throw new Error("上游初始化需要已回读的 OpenAI、Anthropic 或 Grok 平台");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Row;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface OnboardingAccount {
  accountId: number;
  platform: Platform;
  scope: string | null;
  automaticProbeEnabled: boolean;
  ok: boolean;
  templateVerified: boolean;
  responsesMode: string | null;
  responsesVerified: boolean;
  probeReady: boolean;
  groupId: number | null;
  error?: string;
}

export interface OnboardingResult extends Row {
  ok: boolean;
  operation: "initialize";
  targetCount: number;
  verifiedCount: number;
  failedCount: number;
  accounts: OnboardingAccount[];
}

// One shared path for new accounts and explicit repair; never reads supplier keys.
export async function initializeUpstreams(
  config: AppConfig, reads: Pick<Sub2ApiReadClient, "query">,
  runtime: Pick<Sub2ApiRuntimeService, "configureApiKeyAccounts">,
  isolation: Pick<ProbeIsolationService, "ensure">, accountIds: number[],
): Promise<OnboardingResult> {
  const ids = [...new Set(accountIds)].sort((a, b) => a - b);
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("初始化需要有效的上游账号 ID");
  const targets = await reads.query<Row>({
    key: `upstream-initialize-targets:${ids.join(",")}`, kind: "upstream-initialize-targets",
    priority: "manual", cacheMode: "bypass-cache",
    sql: `SELECT a.id, a.platform,
        a.credentials->'temp_unschedulable_enabled' AS temp_enabled,
        a.credentials->'temp_unschedulable_rules' AS temp_rules,
        a.extra->>'openai_responses_mode' AS responses_mode,
        ARRAY(SELECT group_id FROM account_groups WHERE account_id=a.id ORDER BY group_id) AS group_ids
      FROM accounts a WHERE a.deleted_at IS NULL AND LOWER(a.type)='apikey'
        AND a.id=ANY(string_to_array($1::text, ',')::bigint[]) ORDER BY a.id`,
    parameters: [ids.join(",")],
  });
  if (targets.rows.length !== ids.length) throw new Error("部分账号不存在或不是 API-key 上游；未执行初始化");
  const selected = targets.rows.map((row) => ({
    id: Number(row.id), platform: platform(row.platform),
    groupIds: Array.isArray(row.group_ids) ? row.group_ids.map(Number) : [],
    tempEnabled: row.temp_enabled, tempRules: row.temp_rules, responsesMode: row.responses_mode,
  }));
  const accounts: OnboardingAccount[] = [];
  for (const target of selected) {
    const scope = Object.entries(config.operations.upstreamSchedulingV2?.scopes ?? {})
      .find(([, scope]) => scope.platform === target.platform);
    const item: OnboardingAccount = {
      accountId: target.id, platform: target.platform, scope: scope?.[0] ?? null,
      automaticProbeEnabled: config.operations.upstreamSchedulingV2?.enabled === true
        && scope?.[1].enabled === true && scope[1].features.idleProbe === true,
      ok: false, templateVerified: false, responsesMode: null,
      responsesVerified: target.platform !== "openai", probeReady: false, groupId: null,
    };
    try {
      const rules = config.operations.upstreamManagement.failoverRulesByPlatform[target.platform];
      if (!rules.length) throw new Error("目标平台没有切号模板");
      if (target.tempEnabled !== true || canonical(target.tempRules) !== canonical(rules)
        || target.platform === "openai" && target.responsesMode !== "force_responses") {
        await runtime.configureApiKeyAccounts([target.id], {
          credentials: { temp_unschedulable_enabled: true, temp_unschedulable_rules: rules },
          ...(target.platform === "openai" ? { extra: { openai_responses_mode: "force_responses" } } : {}),
        }, config.operations.upstreamManagement.mutationTimeoutMs, target.platform);
      }
      const binding = await isolation.ensure(target.id, {
        platform: target.platform, eligibleGroupIds: target.groupIds, bindingGroupIds: [],
      });
      item.groupId = binding.groupId;
      const verified = await reads.query<Row>({
        key: `upstream-initialize-verify:${target.id}`, kind: "upstream-initialize-verify",
        priority: "manual", cacheMode: "bypass-cache",
        sql: `SELECT a.platform, a.credentials->'temp_unschedulable_enabled' AS temp_enabled,
            a.credentials->'temp_unschedulable_rules' AS temp_rules,
            a.extra->>'openai_responses_mode' AS responses_mode,
            ARRAY(SELECT group_id FROM account_groups WHERE account_id=a.id ORDER BY group_id) AS group_ids,
            g.is_exclusive, g.status AS probe_group_status,
            (SELECT COUNT(*) FROM account_groups WHERE group_id=g.id) AS member_count
          FROM accounts a JOIN groups g ON g.id=$2::bigint AND g.deleted_at IS NULL
          WHERE a.id=$1::bigint AND a.deleted_at IS NULL`,
        parameters: [target.id, binding.groupId],
      });
      const row = verified.rows[0];
      const groups = Array.isArray(row?.group_ids) ? row.group_ids.map(Number).sort((a, b) => a - b) : [];
      const expectedGroups = [...new Set([...target.groupIds, binding.groupId])].sort((a, b) => a - b);
      item.templateVerified = row?.temp_enabled === true && canonical(row.temp_rules) === canonical(rules);
      item.responsesMode = typeof row?.responses_mode === "string" ? row.responses_mode : null;
      item.responsesVerified = target.platform !== "openai" || item.responsesMode === "force_responses";
      item.probeReady = row?.is_exclusive === true && row.probe_group_status === "active"
        && Number(row.member_count) === 1 && canonical(groups) === canonical(expectedGroups);
      item.ok = row?.platform === target.platform && item.templateVerified && item.responsesVerified && item.probeReady;
      if (!item.ok) item.error = "上游初始化写后回读不一致";
    } catch (error) {
      // Keep the stable ID so operators repair this account instead of creating another.
      item.error = error instanceof Error ? error.message : String(error);
    }
    accounts.push(item);
  }
  const verifiedCount = accounts.filter((item) => item.ok).length;
  return { ok: verifiedCount === ids.length, operation: "initialize", targetCount: ids.length,
    verifiedCount, failedCount: ids.length - verifiedCount, accounts, valuesPrinted: false };
}

export async function verifyOnboardingProbes(
  initialized: OnboardingResult, operations: Pick<OperationsService, "runIdleProbe">, operationId: string,
): Promise<Row> {
  const probes: Row[] = [];
  for (const scope of new Set(initialized.accounts.filter((item) => item.ok && item.scope).map((item) => item.scope!))) {
    const ids = initialized.accounts.filter((item) => item.ok && item.scope === scope).map((item) => item.accountId);
    try {
      const result = await operations.runIdleProbe(ids, 1, { operationId: `${operationId}:${scope}`, triggerType: "manual", scope });
      probes.push({ scope, accountIds: ids, ...result,
        verified: result.skipped !== true && Number(result.attempted) === ids.length
          && Number(result.succeeded) === ids.length && Number(result.failed) === 0 });
    } catch (error) {
      probes.push({ scope, accountIds: ids, verified: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const verified = new Set(probes.filter((probe) => probe.verified === true).flatMap((probe) => probe.accountIds as number[]));
  return { ...initialized, ok: initialized.ok && verified.size === initialized.targetCount,
    status: initialized.ok && verified.size === initialized.targetCount ? "ready" : "partial",
    probeVerifiedCount: verified.size, probes };
}

export async function finishUpstreamCreation(
  result: Row, initialize: (ids: number[]) => Promise<OnboardingResult>,
  operations: Pick<OperationsService, "runIdleProbe">, operationId: string,
): Promise<Row> {
  const account = result.account as { id?: unknown } | undefined;
  const accountId = Number(account?.id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error("上游创建未返回稳定账号 ID");
  try {
    const onboarding = await verifyOnboardingProbes(await initialize([accountId]), operations, operationId);
    return { ...result, ok: result.ok === true && onboarding.ok === true, status: onboarding.status, onboarding };
  } catch (error) {
    return { ...result, ok: false, status: "partial", onboarding: { accountId, status: "failed",
      error: error instanceof Error ? error.message : String(error) } };
  }
}
