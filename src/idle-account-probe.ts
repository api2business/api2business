import type { AppConfig } from "./config";
import type { Sub2ApiReadClient, Sub2ApiReadPriority } from "./sub2api-read-executor";
import type { Sub2ApiRuntimeService } from "./sub2api-runtime-service";
import type { ProbeIsolationService } from "./probe-isolation";

const idleProbeCandidatesSql = `
SELECT a.id::int AS account_id, a.name AS account_name, a.platform, a.priority::int AS priority,
  a.status AS account_status, a.schedulable,
  a.rate_limit_reset_at, a.overload_until, a.temp_unschedulable_until,
  sample_stats.available_sample_count
FROM accounts a
CROSS JOIN LATERAL (
  SELECT COUNT(*)::int AS available_sample_count
  FROM (
    SELECT u.id
    FROM usage_logs u
    WHERE u.account_id = a.id
      AND u.created_at >= NOW() - INTERVAL '8 hours'
    UNION ALL
    SELECT o.id
    FROM ops_error_logs o
    WHERE o.account_id = a.id
      AND o.created_at >= NOW() - INTERVAL '8 hours'
      AND (
        LOWER(COALESCE(o.error_message, '')) LIKE ANY (ARRAY[
          '%upstream service temporarily unavailable%', '%upstream request failed%',
          '%bad gateway%', '%gateway timeout%', '%error code: 502%',
          '%error code: 503%', '%error code: 504%', '%error code: 524%'
        ])
        OR o.error_phase = 'upstream'
        OR LOWER(COALESCE(o.error_type, '')) LIKE '%upstream%'
      )
      AND NOT (LOWER(CONCAT_WS(' ', o.error_message, o.error_body,
        o.upstream_error_message, o.upstream_error_detail)) LIKE ANY (ARRAY[
        '%insufficient_balance%', '%insufficient account balance%',
        '%balance is insufficient%', '%余额不足%', '%额度不足%'
      ]))
  ) available_samples
) sample_stats
WHERE a.deleted_at IS NULL
  AND LOWER(TRIM(COALESCE(a.type, ''))) <> 'oauth'
  AND a.status = 'active'
  AND COALESCE(a.schedulable, false) = true
  AND a.platform = $1
  AND EXISTS (
    SELECT 1 FROM account_groups ag
    WHERE ag.account_id = a.id
      AND ag.group_id = ANY(string_to_array($2, ',')::bigint[])
  )
  AND ($5::text IS NULL OR a.id = ANY(string_to_array($5, ',')::bigint[]))
  AND ($6::boolean OR sample_stats.available_sample_count < 100 OR NOT EXISTS (
    SELECT 1 FROM usage_logs u
    WHERE u.account_id = a.id
      AND u.created_at >= NOW() - ($3::int * INTERVAL '1 second')
  ))
  AND ($6::boolean OR sample_stats.available_sample_count < 100 OR NOT EXISTS (
    SELECT 1 FROM ops_error_logs o
    WHERE o.account_id = a.id
      AND o.created_at >= NOW() - ($3::int * INTERVAL '1 second')
  ))
ORDER BY COALESCE((
  SELECT MAX(recent.created_at)
  FROM (
    SELECT MAX(u.created_at) AS created_at FROM usage_logs u WHERE u.account_id = a.id
    UNION ALL
    SELECT MAX(o.created_at) AS created_at FROM ops_error_logs o WHERE o.account_id = a.id
  ) recent
), '-infinity'::timestamptz), a.id
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
}

export const idleProbeRollingUsageSql = `
WITH probe_keys AS (
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
SELECT usage.*, errors.error_requests, errors.latest_error_at
FROM usage CROSS JOIN errors
`;

export class IdleAccountProbeService {
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly reads: Sub2ApiReadClient,
    private readonly runtime: Sub2ApiRuntimeService | null,
    private readonly isolation: ProbeIsolationService | null = null,
  ) {}

  async plan(accountIds: number[] = [], priority: Sub2ApiReadPriority = "manual"): Promise<Record<string, unknown>> {
    const policy = this.config.sub2api.idleProbe;
    const explicit = [...new Set(accountIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
    if (explicit.length !== accountIds.length) throw new Error("idle probe account IDs must be unique positive integers");
    const groupIds = this.config.sub2api.priorityPlan.eligibleGroupIds;
    const result = await this.reads.query<Record<string, unknown>>({
      key: JSON.stringify(["accounts.idle-probe.plan", explicit, policy.idleSeconds, policy.candidateLimit]),
      kind: "accounts.idle-probe.plan",
      sql: idleProbeCandidatesSql,
      parameters: [
        this.config.sub2api.priorityPlan.platform,
        groupIds.join(","),
        policy.idleSeconds,
        explicit.length > 0 ? explicit.length : policy.candidateLimit,
        explicit.length > 0 ? explicit.join(",") : null,
        explicit.length > 0,
      ],
      priority,
      cacheMode: "bypass-cache",
    });
    const candidates = result.rows
      .filter((row) => row.account_status === "active" && row.schedulable === true)
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
      } satisfies IdleProbeCandidate));
    const includeRollingUsage = priority !== "automatic";
    const rolling24Hours = includeRollingUsage ? await this.rollingUsage(priority) : null;
    return {
      ok: true,
      mutation: false,
      model: policy.model,
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
    return {
      windowHours: 24,
      successRequests,
      errorRequests,
      requestAttempts: successRequests + errorRequests,
      sampledAccounts: Number(row.sampled_accounts ?? 0),
      consumedApiAmountUsd: Number(row.consumed_api_amount_usd ?? 0),
      firstSampleAt: row.first_sample_at ?? null,
      latestSampleAt: row.latest_sample_at ?? row.latest_error_at ?? null,
      source: "ordinary-usage-logs-probe-users",
    };
  }

  async reconcile(accountIds: number[] = []): Promise<Record<string, unknown>> {
    if (!this.isolation) throw new Error("idle probe reconciliation requires isolated probe API key");
    const plan = await this.plan(accountIds, "automatic");
    const candidates = (plan.candidates as IdleProbeCandidate[])
      .filter((candidate) => this.isolation!.get(candidate.accountId) === null)
      .slice(0, this.config.sub2api.idleProbe.provisionCandidateLimit);
    const results: Array<Record<string, unknown>> = [];
    for (const candidate of candidates) {
      try {
        const binding = await this.isolation.ensure(candidate.accountId);
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

  async run(accountIds: number[] = [], rounds = 1): Promise<Record<string, unknown>> {
    if (!this.isolation) throw new Error("idle probe execution requires isolated probe API key");
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("idle probe rounds must be an integer from 1 to 10");
    if (this.running) return { ok: true, skipped: true, reason: "in-flight", valuesPrinted: false };
    this.running = true;
    const startedAt = Date.now();
    const policy = this.config.sub2api.idleProbe;
    const results: Array<Record<string, unknown>> = [];
    let planned = 0;
    let ready = 0;
    const unreadyAccountIds = new Set<number>();
    try {
      for (let round = 1; round <= rounds; round += 1) {
        if (Date.now() - startedAt >= policy.roundTimeoutSeconds * 1000) {
          results.push({ round, skipped: true, reason: "round-timeout" });
          break;
        }
        const plan = await this.plan(accountIds, "automatic");
        const plannedCandidates = plan.candidates as IdleProbeCandidate[];
        const candidates = plannedCandidates
          .filter((candidate) => candidate.status === "active" && candidate.schedulable === true)
          .filter((candidate) => this.isolation!.get(candidate.accountId) !== null);
        planned += plannedCandidates.length;
        ready += candidates.length;
        for (const candidate of plannedCandidates) {
          if (this.isolation!.get(candidate.accountId) === null) unreadyAccountIds.add(candidate.accountId);
        }
        // 探活只执行计划中的 active + schedulable 账号，不改变账号运行状态。
        const settled = await Promise.all(candidates.map(async (candidate) => {
            try {
              const jitterMs = idleProbeRequestJitterMs(policy.requestJitterMinMs, policy.requestJitterMaxMs);
              await Bun.sleep(jitterMs);
              const response = await this.isolation!.probe(
                candidate.accountId,
                policy.model,
                policy.accountTimeoutMs,
                policy.reasoningEffort,
              );
              return {
                accountId: candidate.accountId,
                accountName: candidate.accountName,
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
        model: policy.model,
        rounds,
        attempted: succeeded + failed,
        succeeded,
        failed,
        planned,
        ready,
        unreadyAccountIds: [...unreadyAccountIds].sort((left, right) => left - right),
        probeConcurrency: "all-ready-candidates",
        requestJitterMs: { minimum: policy.requestJitterMinMs, maximum: policy.requestJitterMaxMs },
        durationMs: Date.now() - startedAt,
        results,
        evidence: "isolated-user-api-key-responses-request",
        ordinaryLogRecorded,
        valuesPrinted: false,
      };
    } finally {
      this.running = false;
    }
  }
}

export { idleProbeCandidatesSql };
