import type { AppConfig } from "./config";
import type { Sub2ApiReadClient, Sub2ApiReadPriority } from "./sub2api-read-executor";
import type { Sub2ApiRuntimeService } from "./sub2api-runtime-service";
import type { ProbeIsolationService } from "./probe-isolation";

const idleProbeCandidatesSql = `
SELECT a.id::int AS account_id, a.name AS account_name, a.platform, a.priority::int AS priority
FROM accounts a
WHERE a.deleted_at IS NULL
  AND LOWER(TRIM(COALESCE(a.type, ''))) <> 'oauth'
  AND a.platform = $1
  AND a.status = 'active'
  AND a.schedulable = true
  AND (a.rate_limit_reset_at IS NULL OR a.rate_limit_reset_at <= NOW())
  AND (a.overload_until IS NULL OR a.overload_until <= NOW())
  AND (a.temp_unschedulable_until IS NULL OR a.temp_unschedulable_until <= NOW())
  AND EXISTS (
    SELECT 1 FROM account_groups ag
    WHERE ag.account_id = a.id
      AND ag.group_id = ANY(string_to_array($2, ',')::bigint[])
  )
  AND ($5::text IS NULL OR a.id = ANY(string_to_array($5, ',')::bigint[]))
  AND ($6::boolean OR NOT EXISTS (
    SELECT 1 FROM usage_logs u
    WHERE u.account_id = a.id
      AND u.created_at >= NOW() - ($3::int * INTERVAL '1 second')
  ))
  AND ($6::boolean OR NOT EXISTS (
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

export interface IdleProbeCandidate {
  accountId: number;
  accountName: string;
  platform: string;
  priority: number;
}

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
    const candidates = result.rows.map((row) => ({
      accountId: Number(row.account_id),
      accountName: String(row.account_name),
      platform: String(row.platform),
      priority: Number(row.priority),
    } satisfies IdleProbeCandidate));
    return {
      ok: true,
      mutation: false,
      model: policy.model,
      idleSeconds: policy.idleSeconds,
      candidateLimit: policy.candidateLimit,
      candidates,
      databaseQueries: 1,
      queueDurationMs: result.queueDurationMs,
      queryDurationMs: result.queryDurationMs,
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
    try {
      for (let round = 1; round <= rounds; round += 1) {
        if (Date.now() - startedAt >= policy.roundTimeoutSeconds * 1000) {
          results.push({ round, skipped: true, reason: "round-timeout" });
          break;
        }
        const plan = await this.plan(accountIds, "automatic");
        const candidates = plan.candidates as IdleProbeCandidate[];
        for (let offset = 0; offset < candidates.length; offset += policy.concurrency) {
          const batch = candidates.slice(offset, offset + policy.concurrency);
          const settled = await Promise.all(batch.map(async (candidate) => {
            try {
              const response = await this.isolation!.probe(candidate.accountId, policy.model, policy.accountTimeoutMs);
              return { accountId: candidate.accountId, accountName: candidate.accountName, ok: true, response };
            } catch (error) {
              return { accountId: candidate.accountId, accountName: candidate.accountName, ok: false, error: error instanceof Error ? error.message : String(error) };
            }
          }));
          results.push(...settled.map((result) => ({ round, ...result })));
          if (Date.now() - startedAt >= policy.roundTimeoutSeconds * 1000) break;
        }
      }
      const succeeded = results.filter((result) => result.ok === true).length;
      const failed = results.filter((result) => result.ok === false).length;
      return {
        ok: failed === 0,
        skipped: false,
        model: policy.model,
        rounds,
        attempted: succeeded + failed,
        succeeded,
        failed,
        durationMs: Date.now() - startedAt,
        results,
        evidence: "isolated-user-api-key-responses-request",
        ordinaryLogRecorded: true,
        valuesPrinted: false,
      };
    } finally {
      this.running = false;
    }
  }
}

export { idleProbeCandidatesSql };
