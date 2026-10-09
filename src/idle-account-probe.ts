import type { AppConfig } from "./config";
import type { Sub2ApiReadClient, Sub2ApiReadPriority } from "./sub2api-read-executor";
import type { Sub2ApiRuntimeService } from "./sub2api-runtime-service";
import type { ProbeIsolationScope, ProbeIsolationService } from "./probe-isolation";

const idleProbeCandidatesSql = `
WITH target_accounts AS MATERIALIZED (
  SELECT a.id::int AS account_id, a.name AS account_name, a.platform,
    a.priority::int AS priority, a.status AS account_status, a.schedulable,
    a.rate_limit_reset_at, a.overload_until, a.temp_unschedulable_until,
    COALESCE(array_agg(DISTINCT all_binding.group_id::int ORDER BY all_binding.group_id::int)
      FILTER (WHERE all_binding.group_id IS NOT NULL), '{}') AS group_ids,
    COALESCE(ARRAY(SELECT jsonb_object_keys(COALESCE(a.credentials->'model_mapping', '{}'::jsonb))), '{}') AS model_mapping_keys
  FROM accounts a
  LEFT JOIN account_groups all_binding ON all_binding.account_id = a.id
  WHERE a.deleted_at IS NULL
    AND LOWER(TRIM(COALESCE(a.type, ''))) <> 'oauth'
    AND a.platform = $1
    AND ($7::boolean OR (
      a.status = 'active'
      AND COALESCE(a.schedulable, false) = true
      AND EXISTS (
        SELECT 1 FROM account_groups eligible
        WHERE eligible.account_id = a.id
          AND eligible.group_id = ANY(string_to_array($2, ',')::bigint[])
      )
    ))
    AND ($5::text IS NULL OR a.id = ANY(string_to_array($5, ',')::bigint[]))
  GROUP BY a.id, a.name, a.platform, a.priority, a.status, a.schedulable,
    a.rate_limit_reset_at, a.overload_until, a.temp_unschedulable_until, a.credentials
), probe_groups AS (
  SELECT ta.account_id, g.id AS group_id
  FROM target_accounts ta
  JOIN groups g ON g.deleted_at IS NULL
    AND g.platform = ta.platform
    AND g.name IN (
      CONCAT('api2business-probe-', ta.account_id::text),
      CONCAT('api2business-probe-', ta.platform, '-', ta.account_id::text)
    )
), usage_events AS (
  SELECT ta.account_id, u.created_at
  FROM target_accounts ta
  JOIN usage_logs u ON u.account_id = ta.account_id
    AND u.created_at >= NOW() - INTERVAL '8 hours'
  UNION ALL
  SELECT pg.account_id, u.created_at
  FROM probe_groups pg
  JOIN usage_logs u ON u.account_id IS NULL
    AND u.group_id = pg.group_id
    AND u.created_at >= NOW() - INTERVAL '8 hours'
), error_events AS (
  SELECT ta.account_id, o.created_at, o.error_message, o.error_phase,
    o.error_type, o.error_body, o.upstream_error_message, o.upstream_error_detail
  FROM target_accounts ta
  JOIN ops_error_logs o ON o.account_id = ta.account_id
    AND o.created_at >= NOW() - INTERVAL '8 hours'
  UNION ALL
  SELECT pg.account_id, o.created_at, o.error_message, o.error_phase,
    o.error_type, o.error_body, o.upstream_error_message, o.upstream_error_detail
  FROM probe_groups pg
  JOIN ops_error_logs o ON o.account_id IS NULL
    AND o.group_id = pg.group_id
    AND o.created_at >= NOW() - INTERVAL '8 hours'
), sample_counts AS (
  SELECT account_id, COUNT(*)::int AS available_sample_count
  FROM (
    SELECT account_id, created_at FROM usage_events
    UNION ALL
    SELECT account_id, created_at
    FROM error_events
    WHERE (
      LOWER(COALESCE(error_message, '')) LIKE ANY (ARRAY[
        '%upstream service temporarily unavailable%', '%upstream request failed%',
        '%bad gateway%', '%gateway timeout%', '%error code: 502%',
        '%error code: 503%', '%error code: 504%', '%error code: 524%'
      ])
      OR error_phase = 'upstream'
      OR LOWER(COALESCE(error_type, '')) LIKE '%upstream%'
    )
    AND NOT (LOWER(CONCAT_WS(' ', error_message, error_body,
      upstream_error_message, upstream_error_detail)) LIKE ANY (ARRAY[
      '%insufficient_balance%', '%insufficient account balance%',
      '%balance is insufficient%', '%余额不足%', '%额度不足%'
    ]))
  ) all_samples
  GROUP BY account_id
), recent_usage AS (
  SELECT account_id FROM usage_events
  WHERE created_at >= NOW() - ($3::int * INTERVAL '1 second')
  GROUP BY account_id
), recent_errors AS (
  SELECT account_id FROM error_events
  WHERE created_at >= NOW() - ($3::int * INTERVAL '1 second')
  GROUP BY account_id
), recent_activity AS (
  SELECT account_id, MAX(created_at) AS latest_at
  FROM (
    SELECT account_id, created_at FROM usage_events
    UNION ALL
    SELECT account_id, created_at FROM error_events
  ) all_activity
  GROUP BY account_id
)
SELECT ta.account_id, ta.account_name, ta.platform, ta.priority,
  ta.account_status, ta.schedulable, ta.rate_limit_reset_at,
  ta.overload_until, ta.temp_unschedulable_until, ta.group_ids,
  ta.model_mapping_keys,
  COALESCE(sc.available_sample_count, 0)::int AS available_sample_count
FROM target_accounts ta
LEFT JOIN sample_counts sc ON sc.account_id = ta.account_id
LEFT JOIN recent_usage ru ON ru.account_id = ta.account_id
LEFT JOIN recent_errors re ON re.account_id = ta.account_id
LEFT JOIN recent_activity ra ON ra.account_id = ta.account_id
WHERE $6::boolean OR COALESCE(sc.available_sample_count, 0) < 100
  OR ru.account_id IS NULL OR re.account_id IS NULL
ORDER BY COALESCE(ra.latest_at, '-infinity'::timestamptz), ta.account_id
LIMIT $4
`;

export function idleProbeRequestJitterMs(minimumMs: number, maximumMs: number, random = Math.random): number {
  return minimumMs + Math.floor(random() * (maximumMs - minimumMs + 1));
}

export interface IdleProbeCandidate {
  accountId: number;
  accountName: string;
  platform: string;
  priority: number;
  status: string;
  schedulable: boolean;
  hadRuntimeBlock: boolean;
  availableSampleCount: number;
  groupIds: number[];
  probeModel?: string | null;
}

const defaultProbeModels = ["gpt-5.6-terra", "gpt-5.6-sol"] as const;

export function selectIdleProbeModel(
  modelNames: unknown,
  fallbackModel: string,
  preferredModels: readonly string[] = defaultProbeModels,
): string | null {
  const names = Array.isArray(modelNames)
    ? modelNames.map((value) => String(value).trim()).filter(Boolean)
    : [];
  if (names.length === 0) return fallbackModel;
  const normalized = new Map(names.map((name) => [name.toLowerCase(), name]));
  return preferredModels
    .map((model) => normalized.get(model.toLowerCase()))
    .find((model): model is string => model !== undefined)
    ?? names[0]
    ?? fallbackModel;
}

function numericIds(value: unknown): number[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.match(/\d+/gu) ?? []
      : value && typeof value === "object"
        ? Object.values(value as Record<string, unknown>)
      : [];
  return values.map(Number).filter((candidate) => Number.isSafeInteger(candidate) && candidate > 0);
}

export const idleProbeRollingUsageSql = `
WITH monitor_account AS (
  SELECT owner.balance
  FROM users owner
  WHERE owner.email = 'monitor-user@sub2api.platform-infra.local'
    AND owner.deleted_at IS NULL
  LIMIT 1
), probe_keys AS (
  SELECT k.id
  FROM api_keys k
  JOIN users owner ON owner.id = k.user_id
  WHERE owner.email = 'monitor-user@sub2api.platform-infra.local'
    AND owner.deleted_at IS NULL
    AND k.deleted_at IS NULL
    AND k.name LIKE 'api2business-probe-%'
), usage AS (
  SELECT COUNT(*)::int AS success_requests,
    COALESCE(SUM(u.actual_cost), 0)::numeric AS consumed_api_amount_usd,
    MIN(u.created_at) AS first_sample_at,
    MAX(u.created_at) AS latest_sample_at,
    COUNT(DISTINCT u.account_id)::int AS sampled_accounts
  FROM usage_logs u
  JOIN probe_keys p ON p.id = u.api_key_id
  WHERE u.created_at >= NOW() - INTERVAL '24 hours'
), errors AS (
  SELECT COUNT(*)::int AS error_requests,
    MAX(o.created_at) AS latest_error_at
  FROM ops_error_logs o
  JOIN probe_keys p ON p.id = o.api_key_id
  WHERE o.created_at >= NOW() - INTERVAL '24 hours'
)
SELECT usage.*, errors.error_requests, errors.latest_error_at,
  monitor_account.balance AS monitor_balance_usd,
  NOW() AS monitor_balance_queried_at
FROM usage
CROSS JOIN errors
LEFT JOIN monitor_account ON true
`;

export const idleProbeCoverageSql = `
WITH target_accounts AS (
  SELECT a.id::int AS account_id, a.name AS account_name, a.status AS account_status,
    a.schedulable,
    (a.status = 'active' AND COALESCE(a.schedulable, false) = true) AS coverage_required
  FROM accounts a
  WHERE a.deleted_at IS NULL
    AND LOWER(TRIM(COALESCE(a.type, ''))) = 'apikey'
    AND a.platform = $3
    AND EXISTS (
      SELECT 1
      FROM account_groups eligible_ag
      WHERE eligible_ag.account_id = a.id
        AND eligible_ag.group_id = ANY(string_to_array($2, ',')::bigint[])
    )
), probe_keys AS (
  SELECT k.id AS api_key_id,
    SUBSTRING(k.name FROM '^api2business-probe-([0-9]+)$')::int AS account_id
  FROM api_keys k
  JOIN users owner ON owner.id = k.user_id
  WHERE owner.email = 'monitor-user@sub2api.platform-infra.local'
    AND owner.deleted_at IS NULL
    AND k.deleted_at IS NULL
    AND k.name ~ '^api2business-probe-[0-9]+$'
), recent_records AS (
  SELECT p.account_id, COUNT(*)::int AS record_count, COUNT(*) FILTER (WHERE u.id IS NOT NULL)::int AS usage_count,
    0::int AS error_count, MAX(u.created_at) AS latest_record_at
  FROM usage_logs u
  JOIN probe_keys p ON p.api_key_id = u.api_key_id
  WHERE u.created_at >= NOW() - ($1::int * INTERVAL '1 minute')
  GROUP BY p.account_id
  UNION ALL
  SELECT p.account_id, COUNT(*)::int AS record_count, 0::int AS usage_count,
    COUNT(*) FILTER (WHERE o.id IS NOT NULL)::int AS error_count, MAX(o.created_at) AS latest_record_at
  FROM ops_error_logs o
  JOIN probe_keys p ON p.api_key_id = o.api_key_id
  WHERE o.created_at >= NOW() - ($1::int * INTERVAL '1 minute')
  GROUP BY p.account_id
), aggregate AS (
  SELECT account_id, SUM(record_count)::int AS record_count,
    SUM(usage_count)::int AS usage_count, SUM(error_count)::int AS error_count,
    MAX(latest_record_at) AS latest_record_at
  FROM recent_records
  GROUP BY account_id
)
SELECT t.account_id, t.account_name, t.account_status, t.schedulable,
  t.coverage_required,
  COALESCE(a.record_count, 0)::int AS record_count,
  COALESCE(a.usage_count, 0)::int AS usage_count,
  COALESCE(a.error_count, 0)::int AS error_count,
  a.latest_record_at
FROM target_accounts t
LEFT JOIN aggregate a ON a.account_id = t.account_id
ORDER BY (t.coverage_required AND a.latest_record_at IS NULL), a.latest_record_at, t.account_id
`;

export class IdleAccountProbeService {
  // Each scheduling scope has an independent round. A slow Claude/Codex/Grok
  // round must not make the other scopes report a false in-flight skip.
  private readonly runningScopes = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly reads: Sub2ApiReadClient,
    private readonly runtime: Sub2ApiRuntimeService | null,
    private readonly isolation: ProbeIsolationService | null = null,
  ) {}

  async plan(accountIds: number[] = [], priority: Sub2ApiReadPriority = "manual", scopeName?: string): Promise<Record<string, unknown>> {
    const policy = this.config.sub2api.idleProbe;
    const explicit = [...new Set(accountIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
    if (explicit.length !== accountIds.length) throw new Error("idle probe account IDs must be unique positive integers");
    const scope = scopeName ? this.config.operations.upstreamSchedulingV2?.scopes[scopeName] : undefined;
    if (scopeName && (!this.config.operations.upstreamSchedulingV2?.enabled || !scope?.enabled)) {
      throw new Error(`idle probe scope is unavailable: ${scopeName}`);
    }
    const groupIds = scope?.eligibleGroupIds ?? this.config.sub2api.priorityPlan.eligibleGroupIds;
    const probePlatform = scope?.platform ?? this.config.sub2api.priorityPlan.platform;
    const platformModels = policy.platformModels?.[probePlatform] ?? [];
    const defaultProbeModel = platformModels[0] ?? policy.model;
    const result = await this.reads.query<Record<string, unknown>>({
      key: JSON.stringify(["accounts.idle-probe.plan", scopeName ?? null, explicit, policy.idleSeconds, policy.candidateLimit]),
      kind: "accounts.idle-probe.plan",
      sql: idleProbeCandidatesSql,
      parameters: [
        probePlatform,
        groupIds.join(","),
        policy.idleSeconds,
        explicit.length > 0 ? explicit.length : policy.candidateLimit,
        explicit.length > 0 ? explicit.join(",") : null,
        explicit.length > 0,
        explicit.length > 0 && !scopeName,
      ],
      priority,
      cacheMode: "bypass-cache",
    });
    const candidates = result.rows
      .filter((row) => explicit.length > 0 || row.account_status === "active" && row.schedulable === true)
      .map((row) => ({
      accountId: Number(row.account_id),
      accountName: String(row.account_name),
      platform: String(row.platform),
      priority: Number(row.priority),
      status: String(row.account_status ?? "unknown"),
      schedulable: row.schedulable === true,
      hadRuntimeBlock: row.rate_limit_reset_at != null
        || row.overload_until != null
        || row.temp_unschedulable_until != null,
      availableSampleCount: Number(row.available_sample_count ?? 0),
      groupIds: numericIds(row.group_ids),
        probeModel: selectIdleProbeModel(
          row.model_mapping_keys,
          policy.platformModels?.[String(row.platform)]?.[0] ?? policy.model,
          policy.platformModels?.[String(row.platform)] ?? [],
        ),
      } satisfies IdleProbeCandidate));
    const includeRollingUsage = priority !== "automatic";
    const rolling24Hours = includeRollingUsage ? await this.rollingUsage(priority) : null;
    return {
      ok: true,
      mutation: false,
      model: defaultProbeModel,
      idleSeconds: policy.idleSeconds,
      candidateLimit: policy.candidateLimit,
      candidates,
      rolling24Hours,
      databaseQueries: includeRollingUsage ? 2 : 1,
      queueDurationMs: result.queueDurationMs,
      queryDurationMs: result.queryDurationMs,
      valuesPrinted: false,
    };
  }

  async rollingUsage(priority: Sub2ApiReadPriority = "manual"): Promise<Record<string, unknown>> {
    const summary = await this.summary(priority);
    return summary.rolling24Hours as Record<string, unknown>;
  }

  async summary(priority: Sub2ApiReadPriority = "manual"): Promise<Record<string, unknown>> {
    const result = await this.reads.query<Record<string, unknown>>({
      key: "accounts.idle-probe.rolling-24-hours",
      kind: "accounts.idle-probe.rolling-24-hours",
      sql: idleProbeRollingUsageSql,
      parameters: [],
      priority,
      cacheMode: "bypass-cache",
    });
    const row = result.rows[0] ?? {};
    const successRequests = Number(row.success_requests ?? 0);
    const errorRequests = Number(row.error_requests ?? 0);
    const rawBalance = row.monitor_balance_usd;
    const balanceUsd = rawBalance === null || rawBalance === undefined ? null : Number(rawBalance);
    const normalizedBalance = balanceUsd !== null && Number.isFinite(balanceUsd) ? balanceUsd : null;
    return {
      rolling24Hours: {
        windowHours: 24,
        successRequests,
        errorRequests,
        requestAttempts: successRequests + errorRequests,
        sampledAccounts: Number(row.sampled_accounts ?? 0),
        consumedApiAmountUsd: Number(row.consumed_api_amount_usd ?? 0),
        firstSampleAt: row.first_sample_at ?? null,
        latestSampleAt: row.latest_sample_at ?? row.latest_error_at ?? null,
        source: "ordinary-usage-logs-probe-users",
      },
      monitorAccount: {
        balanceUsd: normalizedBalance,
        status: normalizedBalance === null ? "unknown" : normalizedBalance > 0 ? "available" : "depleted",
        queriedAt: row.monitor_balance_queried_at ?? null,
      },
    };
  }

  async coverage(windowMinutes = 20, priority: Sub2ApiReadPriority = "manual", scopeName?: string): Promise<Record<string, unknown>> {
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) {
      throw new Error("idle probe coverage window must be an integer from 1 to 1440 minutes");
    }
    const scheduling = this.config.operations.upstreamSchedulingV2;
    const scope = scopeName ? scheduling?.scopes[scopeName] : undefined;
    if (scopeName && (!scheduling?.enabled || !scope?.enabled)) {
      throw new Error(`idle probe scope is unavailable: ${scopeName}`);
    }
    const selectedScope = scopeName ?? scheduling?.defaultScope ?? "codex";
    const groupIds = scope?.eligibleGroupIds ?? this.config.sub2api.priorityPlan.eligibleGroupIds;
    const platform = scope?.platform ?? this.config.sub2api.priorityPlan.platform;
    const result = await this.reads.query<Record<string, unknown>>({
      key: `accounts.idle-probe.coverage:${selectedScope}:${windowMinutes}`,
      kind: "accounts.idle-probe.coverage",
      sql: idleProbeCoverageSql,
      parameters: [windowMinutes, groupIds.join(","), platform],
      priority,
      cacheMode: "bypass-cache",
    });
    const accounts = result.rows.map((row) => ({
      accountId: Number(row.account_id),
      accountName: String(row.account_name),
      status: String(row.account_status ?? "unknown"),
      schedulable: row.schedulable === true,
      coverageRequired: row.coverage_required === true,
      recordCount: Number(row.record_count ?? 0),
      usageCount: Number(row.usage_count ?? 0),
      errorCount: Number(row.error_count ?? 0),
      latestRecordAt: row.latest_record_at ?? null,
      covered: row.coverage_required !== true || Number(row.record_count ?? 0) > 0,
    }));
    const required = accounts.filter((account) => account.coverageRequired === true);
    const exempt = accounts.filter((account) => account.status === "error");
    const missing = required.filter((account) => account.covered !== true);
    return {
      ok: missing.length === 0,
      mutation: false,
      scope: selectedScope,
      platform,
      windowMinutes,
      observedAt: new Date().toISOString(),
      targetCount: required.length,
      coveredCount: required.length - missing.length,
      missingCount: missing.length,
      exemptErrorCount: exempt.length,
      accounts,
      missingAccountIds: missing.map((account) => account.accountId),
      source: "probe-key-attributed-usage-and-error-logs",
      databaseQueries: 1,
      queueDurationMs: result.queueDurationMs,
      queryDurationMs: result.queryDurationMs,
      valuesPrinted: false,
    };
  }

  async reconcile(accountIds: number[] = [], scopeName?: string): Promise<Record<string, unknown>> {
    if (!this.isolation) throw new Error("idle probe reconciliation requires isolated probe API key");
    const scope = scopeName ? this.config.operations.upstreamSchedulingV2?.scopes[scopeName] : undefined;
    const isolationScope: ProbeIsolationScope | undefined = scope
      ? { platform: scope.platform, eligibleGroupIds: scope.eligibleGroupIds, bindingGroupIds: [] }
      : undefined;
    const plan = await this.plan(accountIds, "automatic", scopeName);
    const candidates = (plan.candidates as IdleProbeCandidate[])
      .filter((candidate) => {
        const binding = this.isolation!.get(candidate.accountId, isolationScope);
        return binding === null || !candidate.groupIds.includes(binding.groupId);
      })
      .slice(0, accountIds.length > 0
        ? accountIds.length
        : this.config.sub2api.idleProbe.provisionCandidateLimit);
    const results: Array<Record<string, unknown>> = [];
    for (const candidate of candidates) {
      try {
        const binding = await this.isolation.ensure(candidate.accountId, isolationScope);
        results.push({
          accountId: candidate.accountId,
          ok: true,
          groupId: binding.groupId,
          keyCreated: binding.keyCreated,
        });
      } catch (error) {
        results.push({
          accountId: candidate.accountId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ok: results.every((result) => result.ok === true),
      mutation: true,
      attempted: results.length,
      succeeded: results.filter((result) => result.ok === true).length,
      failed: results.filter((result) => result.ok === false).length,
      results,
      valuesPrinted: false,
    };
  }

  async run(accountIds: number[] = [], rounds = 1, scopeName?: string): Promise<Record<string, unknown>> {
    if (!this.isolation) throw new Error("idle probe execution requires isolated probe API key");
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("idle probe rounds must be an integer from 1 to 10");
    const runningScope = scopeName ?? "codex";
    if (this.runningScopes.has(runningScope)) {
      return { ok: true, skipped: true, scope: runningScope, reason: "in-flight", valuesPrinted: false };
    }
    this.runningScopes.add(runningScope);
    const startedAt = Date.now();
    const policy = this.config.sub2api.idleProbe;
    const scope = scopeName ? this.config.operations.upstreamSchedulingV2?.scopes[scopeName] : undefined;
    const defaultProbeModel = policy.platformModels?.[scope?.platform ?? this.config.sub2api.priorityPlan.platform]?.[0] ?? policy.model;
    const isolationScope: ProbeIsolationScope | undefined = scope
      ? { platform: scope.platform, eligibleGroupIds: scope.eligibleGroupIds, bindingGroupIds: [] }
      : undefined;
    const results: Array<Record<string, unknown>> = [];
    let planned = 0;
    let ready = 0;
    const unreadyAccountIds = new Set<number>();
    const modelUnavailableAccountIds = new Set<number>();
    try {
      for (let round = 1; round <= rounds; round += 1) {
        if (Date.now() - startedAt >= policy.roundTimeoutSeconds * 1000) {
          results.push({ round, skipped: true, reason: "round-timeout" });
          break;
        }
        const plan = await this.plan(accountIds, "automatic", scopeName);
        const plannedCandidates = plan.candidates as IdleProbeCandidate[];
        const candidates = plannedCandidates
          .filter((candidate) => candidate.status === "active" && candidate.schedulable === true)
          .filter((candidate) => {
            const binding = this.isolation!.get(candidate.accountId, isolationScope);
            return binding !== null && candidate.groupIds.includes(binding.groupId);
          });
        planned += plannedCandidates.length;
        ready += candidates.length;
        for (const candidate of plannedCandidates) {
          const binding = this.isolation!.get(candidate.accountId, isolationScope);
          if (binding === null || !candidate.groupIds.includes(binding.groupId)) {
            unreadyAccountIds.add(candidate.accountId);
          }
        }
        // 探活只执行计划中的 active + schedulable 账号，不改变账号运行状态。
        const settled = await Promise.all(candidates.map(async (candidate) => {
            try {
              const jitterMs = idleProbeRequestJitterMs(policy.requestJitterMinMs, policy.requestJitterMaxMs);
              await Bun.sleep(jitterMs);
              const response = await this.isolation!.probe(
                candidate.accountId,
                candidate.probeModel ?? policy.model,
                policy.accountTimeoutMs,
                policy.reasoningEffort,
              );
              return {
                accountId: candidate.accountId,
                accountName: candidate.accountName,
                model: candidate.probeModel ?? policy.model,
                recoveredBeforeProbe: true,
                jitterMs,
                previousRuntimeState: {
                  status: candidate.status,
                  schedulable: candidate.schedulable,
                  hadRuntimeBlock: candidate.hadRuntimeBlock,
                },
                ok: response.ordinaryLogRecorded === true,
                response,
              };
            } catch (error) {
              return {
                accountId: candidate.accountId,
                accountName: candidate.accountName,
                model: candidate.probeModel ?? policy.model,
                recoveredBeforeProbe: false,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
        }));
        results.push(...settled.map((result) => ({ round, ...result })));
      }
      const succeeded = results.filter((result) => result.ok === true).length;
      const failed = results.filter((result) => result.ok === false).length;
      const ordinaryLogRecorded = results.length > 0 && results.every((result) => {
        const response = result.response;
        return response && typeof response === "object"
          && (response as Record<string, unknown>).ordinaryLogRecorded === true;
      });
      return {
        ok: failed === 0,
        skipped: false,
        model: defaultProbeModel,
        rounds,
        attempted: succeeded + failed,
        succeeded,
        failed,
        planned,
        ready,
        unreadyAccountIds: [...unreadyAccountIds].sort((left, right) => left - right),
        modelUnavailableAccountIds: [...modelUnavailableAccountIds].sort((left, right) => left - right),
        probeConcurrency: "all-ready-candidates",
        requestJitterMs: { minimum: policy.requestJitterMinMs, maximum: policy.requestJitterMaxMs },
        durationMs: Date.now() - startedAt,
        results,
        evidence: "isolated-user-api-key-responses-request",
        ordinaryLogRecorded,
        valuesPrinted: false,
      };
    } finally {
      this.runningScopes.delete(runningScope);
    }
  }
}

export { idleProbeCandidatesSql };
