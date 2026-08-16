import { SQL } from "bun";
import { jitteredIntervalSeconds } from "./priority-automation-schedule";
import { isRecoverableDatabaseConnectionError } from "./database-connection";

export type CashDirection = "income" | "expense";

export interface PriorityOptimizationQueueLease {
  queueName: "priority-optimization-global";
  queuedAt: string;
  acquiredAt: string;
  waitMs: number;
}

type OperationsSqlFactory = (databaseUrl: string, max: number) => SQL;

export function postgresBigintArrayLiteral(values: number[]): string {
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("PostgreSQL bigint array values must be positive integers");
  }
  return `{${values.join(",")}}`;
}

export class OperationsStore {
  private sql: SQL;
  private priorityOptimizationQueueSql: SQL;
  private connectionGeneration = 0;
  private recyclePromise: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly databaseUrl: string,
    private readonly sqlFactory: OperationsSqlFactory = (url, max) => new SQL(url, { max }),
  ) {
    this.sql = this.createSql(4);
    this.priorityOptimizationQueueSql = this.createSql(1);
  }

  async migrate(): Promise<void> {
    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS api2business_cash_entries (
        id uuid PRIMARY KEY,
        occurred_on date NOT NULL,
        direction text NOT NULL CHECK (direction IN ('income','expense')),
        category text NOT NULL,
        amount_cny numeric(14,2) NOT NULL CHECK (amount_cny > 0),
        description text NOT NULL,
        operator text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        voided_at timestamptz,
        voided_by text,
        void_reason text
      );
      CREATE TABLE IF NOT EXISTS api2business_priority_plans (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        created_by text NOT NULL,
        status text NOT NULL CHECK (status IN ('pending','applied','failed','expired')),
        recent_call_limit integer NOT NULL,
        priorities jsonb NOT NULL,
        result jsonb NOT NULL,
        applied_at timestamptz,
        apply_result jsonb
      );
      ALTER TABLE api2business_priority_plans
        ADD COLUMN IF NOT EXISTS trigger_type text NOT NULL DEFAULT 'manual';
      ALTER TABLE api2business_priority_plans
        ADD COLUMN IF NOT EXISTS completed_at timestamptz;
      ALTER TABLE api2business_priority_plans
        ADD COLUMN IF NOT EXISTS execution_started_at timestamptz;
      CREATE TABLE IF NOT EXISTS api2business_priority_automation (
        id text PRIMARY KEY CHECK (id='default'),
        enabled boolean NOT NULL,
        interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 5 AND 86400),
        recent_call_limit integer NOT NULL,
        next_run_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text NOT NULL
      );
      ALTER TABLE api2business_priority_automation
        ADD COLUMN IF NOT EXISTS run_id uuid;
      ALTER TABLE api2business_priority_automation
        ADD COLUMN IF NOT EXISTS run_started_at timestamptz;
      ALTER TABLE api2business_priority_automation
        ADD COLUMN IF NOT EXISTS run_claimed_at timestamptz;
      ALTER TABLE api2business_priority_automation
        ADD COLUMN IF NOT EXISTS last_completed_at timestamptz;
      ALTER TABLE api2business_priority_automation
        ADD COLUMN IF NOT EXISTS last_run_status text;
      CREATE TABLE IF NOT EXISTS api2business_operation_audit (
        id uuid PRIMARY KEY,
        action text NOT NULL,
        status text NOT NULL,
        operator text NOT NULL,
        input_summary jsonb NOT NULL,
        result_summary jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS api2business_api_cache (
        cache_key text PRIMARY KEY,
        status integer NOT NULL,
        headers jsonb NOT NULL,
        body text NOT NULL,
        cached_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS api2business_snapshots (
        snapshot_key text PRIMARY KEY,
        schema_version text NOT NULL,
        payload jsonb,
        captured_at timestamptz,
        refresh_started_at timestamptz,
        last_error text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS api2business_upstream_usage_cache (
        account_id bigint PRIMARY KEY,
        result jsonb NOT NULL,
        queried_at timestamptz NOT NULL DEFAULT now(),
        last_success_result jsonb,
        last_success_at timestamptz
      );
      ALTER TABLE api2business_upstream_usage_cache
        ADD COLUMN IF NOT EXISTS last_success_result jsonb;
      ALTER TABLE api2business_upstream_usage_cache
        ADD COLUMN IF NOT EXISTS last_success_at timestamptz;
      UPDATE api2business_upstream_usage_cache
      SET last_success_result=result, last_success_at=queried_at
      WHERE last_success_result IS NULL
        AND COALESCE((result->>'ok')::boolean, false);
      CREATE TABLE IF NOT EXISTS api2business_upstream_quota_samples (
        sampled_at timestamptz NOT NULL,
        wallet_key text NOT NULL,
        account_id bigint NOT NULL,
        schedulable boolean NOT NULL,
        status text NOT NULL,
        provider text NOT NULL,
        probe_ok boolean NOT NULL,
        remaining_usd numeric,
        cny_per_usd numeric NOT NULL,
        remaining_cny numeric,
        source_queried_at timestamptz,
        api_amount_usd_total numeric,
        wallet_api_amount_usd_total numeric,
        account_cost_inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
        PRIMARY KEY (sampled_at, wallet_key)
      );
      ALTER TABLE api2business_upstream_quota_samples
        ADD COLUMN IF NOT EXISTS api_amount_usd_total numeric;
      ALTER TABLE api2business_upstream_quota_samples
        ADD COLUMN IF NOT EXISTS wallet_api_amount_usd_total numeric;
      ALTER TABLE api2business_upstream_quota_samples
        ADD COLUMN IF NOT EXISTS account_cost_inputs jsonb NOT NULL DEFAULT '[]'::jsonb;
      CREATE INDEX IF NOT EXISTS api2business_upstream_quota_samples_wallet_time_idx
        ON api2business_upstream_quota_samples(wallet_key, sampled_at DESC);
      CREATE TABLE IF NOT EXISTS api2business_oauth_runtime_samples (
        sampled_at timestamptz NOT NULL,
        profile text NOT NULL CHECK (profile IN ('codex','grok')),
        api_amount_usd_total numeric NOT NULL,
        expected_api_amount_usd numeric,
        remaining_expected_api_amount_usd numeric,
        account_count integer NOT NULL,
        normal_count integer NOT NULL,
        rate_limited_count integer NOT NULL,
        error_count integer NOT NULL,
        PRIMARY KEY (sampled_at, profile)
      );
      CREATE INDEX IF NOT EXISTS api2business_oauth_runtime_samples_profile_time_idx
        ON api2business_oauth_runtime_samples(profile, sampled_at DESC);
      CREATE TABLE IF NOT EXISTS api2business_pool_quality_samples (
        sampled_at timestamptz PRIMARY KEY,
        score numeric,
        grade text NOT NULL,
        observed_attempts integer NOT NULL,
        success_requests integer NOT NULL,
        failure_requests integer NOT NULL,
        failure_rate numeric,
        failover_requests integer NOT NULL,
        failover_recovered integer NOT NULL,
        ttft_p95_ms integer,
        first_token_samples integer NOT NULL,
        participation jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS api2business_pool_quality_samples_time_idx
        ON api2business_pool_quality_samples(sampled_at DESC);
      CREATE TABLE IF NOT EXISTS api2business_bugteam_cost_samples (
        sampled_at timestamptz NOT NULL,
        product text NOT NULL,
        status text NOT NULL CHECK (status IN ('ok','empty','error')),
        available integer,
        unit_price_cny numeric,
        minimum_unit_price_cny numeric,
        maximum_unit_price_cny numeric,
        minimum_remaining_seconds integer,
        maximum_remaining_seconds integer,
        expected_cost_cny_per_api_usd numeric,
        minimum_expected_cost_cny_per_api_usd numeric,
        maximum_expected_cost_cny_per_api_usd numeric,
        fill_rate_api_usd_per_hour numeric,
        error_summary text,
        PRIMARY KEY (sampled_at, product)
      );
      CREATE INDEX IF NOT EXISTS api2business_bugteam_cost_samples_product_time_idx
        ON api2business_bugteam_cost_samples(product, sampled_at DESC);
      CREATE TABLE IF NOT EXISTS api2business_idle_probe_rounds (
        id uuid PRIMARY KEY,
        operation_id text NOT NULL UNIQUE,
        trigger_type text NOT NULL CHECK (trigger_type IN ('manual','automatic')),
        started_at timestamptz NOT NULL,
        completed_at timestamptz NOT NULL,
        status text NOT NULL CHECK (status IN ('succeeded','partial','failed','skipped')),
        planned_count integer NOT NULL,
        ready_count integer NOT NULL,
        attempted_count integer NOT NULL,
        succeeded_count integer NOT NULL,
        failed_count integer NOT NULL,
        unready_count integer NOT NULL,
        duration_ms integer NOT NULL,
        error_summary text
      );
      CREATE TABLE IF NOT EXISTS api2business_upstream_benchmark_runs (
        id uuid PRIMARY KEY,
        account_id bigint NOT NULL,
        provider text NOT NULL,
        benchmark_version text NOT NULL,
        model text NOT NULL,
        state text NOT NULL CHECK (state IN ('running','succeeded','failed')),
        score numeric(6,2),
        dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
        probes jsonb NOT NULL DEFAULT '[]'::jsonb,
        requested_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        duration_ms integer,
        error_summary text
      );
      CREATE INDEX IF NOT EXISTS api2business_upstream_benchmark_account_time
        ON api2business_upstream_benchmark_runs (account_id, requested_at DESC);
      CREATE TABLE IF NOT EXISTS api2business_upstream_benchmark_events (
        id bigserial PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES api2business_upstream_benchmark_runs(id) ON DELETE CASCADE,
        sequence integer NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        stage text NOT NULL,
        probe_id text,
        level text NOT NULL CHECK (level IN ('info','success','error')),
        message text NOT NULL,
        duration_ms integer,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (run_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS api2business_upstream_benchmark_events_run_sequence
        ON api2business_upstream_benchmark_events (run_id, sequence);
      CREATE INDEX IF NOT EXISTS api2business_idle_probe_rounds_started_at_idx
        ON api2business_idle_probe_rounds(started_at DESC);
      CREATE INDEX IF NOT EXISTS api2business_cash_entries_occurred_on_idx
        ON api2business_cash_entries(occurred_on DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS api2business_operation_audit_created_at_idx
        ON api2business_operation_audit(created_at DESC);
    `);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.recyclePromise) await this.recyclePromise;
    await Promise.all([this.sql.close(), this.priorityOptimizationQueueSql.close()]);
  }

  async health(): Promise<void> {
    await this.withConnectionRecovery(async () => {
      await this.sql`SELECT 1 AS ok`;
    });
  }

  async recoverConnection(error: unknown): Promise<boolean> {
    if (!isRecoverableDatabaseConnectionError(error)) return false;
    // A concurrent request may already have replaced the stale pool. Probing the
    // current generation avoids recycling that fresh pool for a late old error.
    await this.health();
    return true;
  }

  async getApiCache(key: string) {
    return await this.withConnectionRecovery(async () => {
      const [row] = await this.sql`
        SELECT cache_key, status, headers, body, cached_at
        FROM api2business_api_cache WHERE cache_key=${key}
      `;
      return row ?? null;
    });
  }

  async setApiCache(key: string, status: number, headers: Record<string, string>, body: string) {
    await this.withConnectionRecovery(async () => {
      await this.sql`
        INSERT INTO api2business_api_cache (cache_key, status, headers, body, cached_at)
        VALUES (${key}, ${status}, ${headers}::jsonb, ${body}, now())
        ON CONFLICT (cache_key) DO UPDATE SET
          status=EXCLUDED.status, headers=EXCLUDED.headers, body=EXCLUDED.body, cached_at=now()
      `;
    });
  }

  private createSql(max: number): SQL {
    return this.sqlFactory(this.databaseUrl, max);
  }

  private async withConnectionRecovery<T>(operation: () => Promise<T>): Promise<T> {
    const observedGeneration = this.connectionGeneration;
    try {
      return await operation();
    } catch (error) {
      if (!isRecoverableDatabaseConnectionError(error)) throw error;
      await this.recycleConnections(observedGeneration);
      return await operation();
    }
  }

  private async recycleConnections(observedGeneration: number): Promise<void> {
    if (this.closed || observedGeneration !== this.connectionGeneration) return;
    if (this.recyclePromise) return await this.recyclePromise;
    const recycle = (async () => {
      if (this.closed || observedGeneration !== this.connectionGeneration) return;
      const expiredSql = this.sql;
      const expiredQueueSql = this.priorityOptimizationQueueSql;
      this.sql = this.createSql(4);
      this.priorityOptimizationQueueSql = this.createSql(1);
      this.connectionGeneration += 1;
      await Promise.race([
        Promise.all([
          expiredSql.close({ timeout: 1 }).catch(() => undefined),
          expiredQueueSql.close({ timeout: 1 }).catch(() => undefined),
        ]),
        Bun.sleep(1500),
      ]);
    })();
    this.recyclePromise = recycle;
    try {
      await recycle;
    } finally {
      if (this.recyclePromise === recycle) this.recyclePromise = null;
    }
  }

  async getSnapshot(key: string) {
    const [row] = await this.sql`
      SELECT snapshot_key, schema_version, payload, captured_at, refresh_started_at,
        last_error, updated_at
      FROM api2business_snapshots WHERE snapshot_key=${key}
    `;
    return row ?? null;
  }

  async beginSnapshotRefresh(key: string, schemaVersion: string, startedAt: string) {
    await this.sql`
      INSERT INTO api2business_snapshots
        (snapshot_key, schema_version, refresh_started_at, last_error, updated_at)
      VALUES (${key}, ${schemaVersion}, ${startedAt}, NULL, now())
      ON CONFLICT (snapshot_key) DO UPDATE SET
        schema_version=EXCLUDED.schema_version,
        refresh_started_at=EXCLUDED.refresh_started_at,
        last_error=NULL,
        updated_at=now()
    `;
  }

  async completeSnapshot(key: string, schemaVersion: string, payload: Record<string, unknown>, capturedAt: string) {
    await this.sql`
      INSERT INTO api2business_snapshots
        (snapshot_key, schema_version, payload, captured_at, refresh_started_at, last_error, updated_at)
      VALUES (${key}, ${schemaVersion}, ${payload}::jsonb, ${capturedAt}, NULL, NULL, now())
      ON CONFLICT (snapshot_key) DO UPDATE SET
        schema_version=EXCLUDED.schema_version,
        payload=EXCLUDED.payload,
        captured_at=EXCLUDED.captured_at,
        refresh_started_at=NULL,
        last_error=NULL,
        updated_at=now()
    `;
  }

  async failSnapshotRefresh(key: string, schemaVersion: string, error: string) {
    await this.sql`
      INSERT INTO api2business_snapshots
        (snapshot_key, schema_version, refresh_started_at, last_error, updated_at)
      VALUES (${key}, ${schemaVersion}, NULL, ${error.slice(0, 500)}, now())
      ON CONFLICT (snapshot_key) DO UPDATE SET
        schema_version=EXCLUDED.schema_version,
        refresh_started_at=NULL,
        last_error=EXCLUDED.last_error,
        updated_at=now()
    `;
  }

  async getUpstreamUsageCache(accountIds: number[]) {
    if (!accountIds.length) return await this.sql`
      SELECT account_id, result, queried_at, last_success_result, last_success_at
      FROM api2business_upstream_usage_cache ORDER BY account_id
    `;
    const accountIdArray = postgresBigintArrayLiteral(accountIds);
    return await this.sql`
      SELECT account_id, result, queried_at, last_success_result, last_success_at
      FROM api2business_upstream_usage_cache
      WHERE account_id = ANY(${accountIdArray}::bigint[]) ORDER BY account_id
    `;
  }

  async setUpstreamUsageCache(results: Array<Record<string, unknown>>, samples: import("./upstream-quota-monitor").UpstreamQuotaSample[] = [], apiAmountUsdTotal: number | null = null) {
    await this.sql.begin(async (tx) => {
      for (const result of results) {
        const accountId = Number(result.accountId);
        if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
        await tx`
          INSERT INTO api2business_upstream_usage_cache (
            account_id, result, queried_at, last_success_result, last_success_at
          ) VALUES (
            ${accountId}, ${result}::jsonb, now(),
            CASE WHEN COALESCE((${result}::jsonb->>'ok')::boolean, false) THEN ${result}::jsonb ELSE NULL END,
            CASE WHEN COALESCE((${result}::jsonb->>'ok')::boolean, false) THEN now() ELSE NULL END
          )
          ON CONFLICT (account_id) DO UPDATE SET
            result=EXCLUDED.result,
            queried_at=now(),
            last_success_result=CASE
              WHEN COALESCE((EXCLUDED.result->>'ok')::boolean, false) THEN EXCLUDED.result
              ELSE api2business_upstream_usage_cache.last_success_result
            END,
            last_success_at=CASE
              WHEN COALESCE((EXCLUDED.result->>'ok')::boolean, false) THEN now()
              ELSE api2business_upstream_usage_cache.last_success_at
            END
        `;
      }
      for (const sample of samples) {
        await tx`
          INSERT INTO api2business_upstream_quota_samples (
            sampled_at, wallet_key, account_id, schedulable, status, provider,
            probe_ok, remaining_usd, cny_per_usd, remaining_cny, source_queried_at,
            api_amount_usd_total, wallet_api_amount_usd_total, account_cost_inputs
          ) VALUES (${sample.sampledAt}, ${sample.walletKey}, ${sample.accountId},
            ${sample.schedulable}, ${sample.status}, ${sample.provider}, ${sample.probeOk},
            ${sample.remainingUsd}, ${sample.cnyPerUsd}, ${sample.remainingCny}, ${sample.sourceQueriedAt},
            ${apiAmountUsdTotal}, ${sample.walletApiAmountUsdTotal ?? null}, ${sample.accountCostInputs ?? []}::jsonb)
          ON CONFLICT (sampled_at, wallet_key) DO NOTHING
        `;
      }
    });
  }

  async getUpstreamQuotaSamples(hours: number) {
    return await this.sql`
      SELECT sampled_at, wallet_key, account_id, schedulable, status, provider,
        probe_ok, remaining_usd, cny_per_usd, remaining_cny, source_queried_at,
        api_amount_usd_total, wallet_api_amount_usd_total, account_cost_inputs
      FROM api2business_upstream_quota_samples
      WHERE sampled_at >= now() - (${hours}::text || ' hours')::interval
         OR sampled_at IN (
           SELECT sampled_at FROM (
             SELECT DISTINCT sampled_at FROM api2business_upstream_quota_samples
             ORDER BY sampled_at DESC LIMIT 13
           ) recent
         )
      ORDER BY sampled_at, wallet_key
    `;
  }

  async getLatestSuccessfulUpstreamQuotaSamples() {
    return await this.sql`
      SELECT DISTINCT ON (wallet_key)
        sampled_at, wallet_key, account_id, remaining_usd, cny_per_usd,
        remaining_cny, source_queried_at, account_cost_inputs
      FROM api2business_upstream_quota_samples
      WHERE probe_ok=true AND remaining_cny IS NOT NULL
      ORDER BY wallet_key, sampled_at DESC
    `;
  }

  async addOAuthRuntimeSamples(samples: import("./oauth-runtime-monitor").OAuthRuntimeSample[]) {
    await this.sql.begin(async (tx) => {
      for (const sample of samples) {
        await tx`
          INSERT INTO api2business_oauth_runtime_samples (
            sampled_at, profile, api_amount_usd_total, expected_api_amount_usd,
            remaining_expected_api_amount_usd, account_count, normal_count,
            rate_limited_count, error_count
          ) VALUES (${sample.sampledAt}, ${sample.profile}, ${sample.apiAmountUsdTotal},
            ${sample.expectedApiAmountUsd}, ${sample.remainingExpectedApiAmountUsd},
            ${sample.accountCount}, ${sample.normalCount}, ${sample.rateLimitedCount}, ${sample.errorCount})
          ON CONFLICT (sampled_at, profile) DO NOTHING
        `;
      }
    });
  }

  async getOAuthRuntimeSamples(profile: "codex" | "grok", hours: number) {
    return await this.sql`
      SELECT sampled_at, profile, api_amount_usd_total, expected_api_amount_usd,
        remaining_expected_api_amount_usd, account_count, normal_count,
        rate_limited_count, error_count
      FROM api2business_oauth_runtime_samples
      WHERE profile=${profile}
        AND (sampled_at >= now() - (${hours}::text || ' hours')::interval
          OR sampled_at IN (
            SELECT sampled_at FROM api2business_oauth_runtime_samples
            WHERE profile=${profile} ORDER BY sampled_at DESC LIMIT 13
          ))
      ORDER BY sampled_at
    `;
  }

  async addPoolQualitySample(sample: import("./pool-quality-monitor").PoolQualitySample) {
    await this.sql`
      INSERT INTO api2business_pool_quality_samples (
        sampled_at, score, grade, observed_attempts, success_requests, failure_requests,
        failure_rate, failover_requests, failover_recovered, ttft_p95_ms,
        first_token_samples, participation
      ) VALUES (${sample.sampledAt}, ${sample.score}, ${sample.grade}, ${sample.observedAttempts},
        ${sample.successRequests}, ${sample.failureRequests}, ${sample.failureRate},
        ${sample.failoverRequests}, ${sample.failoverRecovered}, ${sample.ttftP95Ms},
        ${sample.firstTokenSamples}, ${sample.participation}::jsonb)
      ON CONFLICT (sampled_at) DO NOTHING
    `;
  }

  async getPoolQualitySamples(hours: number) {
    return await this.sql`
      SELECT sampled_at, score, grade, observed_attempts, success_requests,
        failure_requests, failure_rate, failover_requests, failover_recovered,
        ttft_p95_ms, first_token_samples, participation
      FROM api2business_pool_quality_samples
      WHERE sampled_at >= now() - (${hours}::text || ' hours')::interval
         OR sampled_at IN (
           SELECT sampled_at FROM api2business_pool_quality_samples
           ORDER BY sampled_at DESC LIMIT 13
         )
      ORDER BY sampled_at
    `;
  }

  async addBugTeamCostSample(sample: import("./bugteam-cost-monitor").BugTeamCostSample) {
    await this.sql`
      INSERT INTO api2business_bugteam_cost_samples (
        sampled_at, product, status, available, unit_price_cny,
        minimum_unit_price_cny, maximum_unit_price_cny,
        minimum_remaining_seconds, maximum_remaining_seconds,
        expected_cost_cny_per_api_usd, minimum_expected_cost_cny_per_api_usd,
        maximum_expected_cost_cny_per_api_usd, fill_rate_api_usd_per_hour,
        error_summary
      ) VALUES (${sample.sampledAt}, ${sample.product}, ${sample.status}, ${sample.available},
        ${sample.unitPriceCny}, ${sample.minimumUnitPriceCny}, ${sample.maximumUnitPriceCny},
        ${sample.minimumRemainingSeconds}, ${sample.maximumRemainingSeconds},
        ${sample.expectedCostCnyPerApiUsd}, ${sample.minimumExpectedCostCnyPerApiUsd},
        ${sample.maximumExpectedCostCnyPerApiUsd}, ${sample.fillRateApiUsdPerHour},
        ${sample.errorSummary})
      ON CONFLICT (sampled_at, product) DO NOTHING
    `;
  }

  async getBugTeamCostSamples(product: string, hours: number) {
    return await this.sql`
      SELECT sampled_at, product, status, available, unit_price_cny,
        minimum_unit_price_cny, maximum_unit_price_cny,
        minimum_remaining_seconds, maximum_remaining_seconds,
        expected_cost_cny_per_api_usd, minimum_expected_cost_cny_per_api_usd,
        maximum_expected_cost_cny_per_api_usd, fill_rate_api_usd_per_hour,
        error_summary
      FROM api2business_bugteam_cost_samples
      WHERE product=${product}
        AND sampled_at >= now() - (${hours}::text || ' hours')::interval
      ORDER BY sampled_at
    `;
  }

  async addIdleProbeRound(input: {
    operationId: string;
    triggerType: "manual" | "automatic";
    startedAt: string;
    completedAt: string;
    status: "succeeded" | "partial" | "failed" | "skipped";
    plannedCount: number;
    readyCount: number;
    attemptedCount: number;
    succeededCount: number;
    failedCount: number;
    unreadyCount: number;
    durationMs: number;
    errorSummary: string | null;
  }) {
    await this.sql`
      INSERT INTO api2business_idle_probe_rounds (
        id, operation_id, trigger_type, started_at, completed_at, status,
        planned_count, ready_count, attempted_count, succeeded_count,
        failed_count, unready_count, duration_ms, error_summary
      ) VALUES (${crypto.randomUUID()}, ${input.operationId}, ${input.triggerType},
        ${input.startedAt}, ${input.completedAt}, ${input.status}, ${input.plannedCount},
        ${input.readyCount}, ${input.attemptedCount}, ${input.succeededCount},
        ${input.failedCount}, ${input.unreadyCount}, ${input.durationMs}, ${input.errorSummary})
      ON CONFLICT (operation_id) DO NOTHING
    `;
  }

  async idleProbeHistoryPage(limit: number, offset: number) {
    return await this.sql`
      SELECT operation_id, trigger_type, started_at, completed_at, status,
        planned_count, ready_count, attempted_count, succeeded_count,
        failed_count, unready_count, duration_ms, error_summary,
        COUNT(*) OVER()::int AS total_count
      FROM api2business_idle_probe_rounds
      ORDER BY started_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  async latestAutomaticIdleProbeRound(): Promise<{
    operation_id: string;
    completed_at: string;
    status: "succeeded" | "partial" | "failed" | "skipped";
  } | null> {
    const rows = await this.sql`
      SELECT operation_id, completed_at::text AS completed_at, status
      FROM api2business_idle_probe_rounds
      WHERE trigger_type = 'automatic'
      ORDER BY completed_at DESC, id DESC
      LIMIT 1
    ` as Array<{
      operation_id: string;
      completed_at: string;
      status: "succeeded" | "partial" | "failed" | "skipped";
    }>;
    return rows[0] ?? null;
  }

  async startUpstreamBenchmark(input: { accountId: number; provider: string; benchmarkVersion: string; model: string }) {
    const id = crypto.randomUUID();
    await this.sql`
      INSERT INTO api2business_upstream_benchmark_runs
        (id, account_id, provider, benchmark_version, model, state)
      VALUES (${id}, ${input.accountId}, ${input.provider}, ${input.benchmarkVersion}, ${input.model}, 'running')
    `;
    return id;
  }

  async addUpstreamBenchmarkEvent(runId: string, input: { stage: string; probeId?: string | null; level?: "info" | "success" | "error"; message: string; durationMs?: number | null; details?: Record<string, unknown> }) {
    await this.sql`
      INSERT INTO api2business_upstream_benchmark_events
        (run_id, sequence, stage, probe_id, level, message, duration_ms, details)
      SELECT ${runId}, COALESCE(MAX(sequence), 0) + 1, ${input.stage}, ${input.probeId ?? null},
        ${input.level ?? "info"}, ${input.message.slice(0, 500)}, ${input.durationMs ?? null},
        ${input.details ?? {}}::jsonb
      FROM api2business_upstream_benchmark_events WHERE run_id=${runId}
    `;
  }

  async finishUpstreamBenchmark(id: string, input: { state: "succeeded" | "failed"; score: number | null; dimensions: Record<string, unknown>; probes: unknown[]; durationMs: number; errorSummary: string | null }) {
    await this.sql`
      UPDATE api2business_upstream_benchmark_runs SET
        state=${input.state}, score=${input.score}, dimensions=${input.dimensions}::jsonb,
        probes=${input.probes}::jsonb, completed_at=now(), duration_ms=${input.durationMs},
        error_summary=${input.errorSummary}
      WHERE id=${id}
    `;
  }

  async latestUpstreamBenchmarks(accountIds: number[] = []) {
    if (!accountIds.length) return await this.sql`
      SELECT DISTINCT ON (account_id) id, account_id, provider, benchmark_version, model,
        state, score, dimensions, probes, requested_at, completed_at, duration_ms, error_summary
      FROM api2business_upstream_benchmark_runs ORDER BY account_id, requested_at DESC
    `;
    const values = postgresBigintArrayLiteral(accountIds);
    return await this.sql`
      SELECT DISTINCT ON (account_id) id, account_id, provider, benchmark_version, model,
        state, score, dimensions, probes, requested_at, completed_at, duration_ms, error_summary
      FROM api2business_upstream_benchmark_runs
      WHERE account_id = ANY(${values}::bigint[]) ORDER BY account_id, requested_at DESC
    `;
  }

  async upstreamBenchmarkRun(id: string) {
    const [row] = await this.sql`
      SELECT id, account_id, provider, benchmark_version, model, state, score, dimensions,
        probes, requested_at, completed_at, duration_ms, error_summary
      FROM api2business_upstream_benchmark_runs WHERE id=${id}
    `;
    return row ?? null;
  }

  async upstreamBenchmarkEvents(id: string, limit = 100) {
    return await this.sql`
      SELECT sequence, occurred_at, stage, probe_id, level, message, duration_ms, details
      FROM api2business_upstream_benchmark_events WHERE run_id=${id}
      ORDER BY sequence ASC LIMIT ${limit}
    `;
  }

  async upstreamBenchmarkHistory(accountId: number, limit = 20) {
    return await this.sql`
      SELECT id, account_id, provider, benchmark_version, model, state, score, dimensions,
        probes, requested_at, completed_at, duration_ms, error_summary
      FROM api2business_upstream_benchmark_runs WHERE account_id=${accountId}
      ORDER BY requested_at DESC LIMIT ${limit}
    `;
  }

  async restoreUpstreamUsageSuccess(accountId: number, result: Record<string, unknown>) {
    await this.sql`
      INSERT INTO api2business_upstream_usage_cache (
        account_id, result, queried_at, last_success_result, last_success_at
      ) VALUES (${accountId}, ${result}::jsonb, now(), ${result}::jsonb, now())
      ON CONFLICT (account_id) DO UPDATE SET
        last_success_result=EXCLUDED.last_success_result,
        last_success_at=now()
    `;
  }

  async withPriorityOptimizationQueue<T>(
    operation: (lease: PriorityOptimizationQueueLease) => Promise<T>,
  ): Promise<T> {
    const queuedAt = new Date().toISOString();
    const queuedAtMs = Date.now();
    const connection = await this.priorityOptimizationQueueSql.reserve();
    let locked = false;
    let reusable = true;
    try {
      await connection`
        SELECT pg_advisory_lock(
          hashtext(${"api2business"}),
          hashtext(${"priority-optimization-global"})
        )
      `;
      locked = true;
      const acquiredAt = new Date().toISOString();
      return await operation({
        queueName: "priority-optimization-global",
        queuedAt,
        acquiredAt,
        waitMs: Date.now() - queuedAtMs,
      });
    } finally {
      if (locked) {
        try {
          await connection`
            SELECT pg_advisory_unlock(
              hashtext(${"api2business"}),
              hashtext(${"priority-optimization-global"})
            )
          `;
        } catch {
          reusable = false;
          await connection.close();
        }
      }
      if (reusable) connection.release();
    }
  }

  async addCash(input: { occurredOn: string; direction: CashDirection; category: string; amountCny: number; description: string; operator: string }) {
    const id = crypto.randomUUID();
    const [row] = await this.sql`
      INSERT INTO api2business_cash_entries
        (id, occurred_on, direction, category, amount_cny, description, operator)
      VALUES (${id}, ${input.occurredOn}, ${input.direction}, ${input.category},
        ${input.amountCny}, ${input.description}, ${input.operator})
      RETURNING id, occurred_on, direction, category, amount_cny, description,
        operator, created_at, voided_at, voided_by, void_reason
    `;
    return row;
  }

  async voidCash(id: string, operator: string, reason: string) {
    const [row] = await this.sql`
      UPDATE api2business_cash_entries
      SET voided_at=now(), voided_by=${operator}, void_reason=${reason}
      WHERE id=${id} AND voided_at IS NULL
      RETURNING id, occurred_on, direction, category, amount_cny, description,
        operator, created_at, voided_at, voided_by, void_reason
    `;
    if (!row) throw new Error("cash entry does not exist or is already voided");
    return row;
  }

  async cashSummary(period: string) {
    const [row] = await this.sql`
      SELECT
        COUNT(*)::int AS total_count,
        COALESCE(SUM(amount_cny) FILTER (WHERE direction='income' AND voided_at IS NULL AND to_char(occurred_on, 'YYYY-MM')=${period}), 0) AS income_cny,
        COALESCE(SUM(amount_cny) FILTER (WHERE direction='expense' AND voided_at IS NULL AND to_char(occurred_on, 'YYYY-MM')=${period}), 0) AS expense_cny
      FROM api2business_cash_entries
    `;
    return row ?? { income_cny: 0, expense_cny: 0 };
  }

  async cashDaySummary(day: string) {
    const [row] = await this.sql`
      SELECT
        COUNT(*) FILTER (WHERE voided_at IS NULL)::int AS total_count,
        COALESCE(SUM(amount_cny) FILTER (WHERE direction='income' AND voided_at IS NULL), 0) AS income_cny,
        COALESCE(SUM(amount_cny) FILTER (WHERE direction='expense' AND voided_at IS NULL), 0) AS expense_cny
      FROM api2business_cash_entries
      WHERE occurred_on=${day}
    `;
    return row ?? { total_count: 0, income_cny: 0, expense_cny: 0 };
  }

  async listCashPage(limit: number, offset: number) {
    return await this.sql`
      SELECT id, occurred_on, direction, category, amount_cny, description,
        operator, created_at, voided_at, voided_by, void_reason,
        COUNT(*) OVER()::int AS total_count
      FROM api2business_cash_entries ORDER BY occurred_on DESC, created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  async createPlan(input: {
    operator: string;
    recentCallLimit: number;
    ttlMinutes: number;
    priorities: Record<string, number>;
    result: unknown;
    triggerType?: "manual" | "automatic";
    executionStartedAt?: string | null;
  }) {
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
    await this.sql`
      INSERT INTO api2business_priority_plans
        (id, expires_at, created_by, status, recent_call_limit, priorities, result,
          trigger_type, execution_started_at)
      VALUES (${id}, ${expiresAt}, ${input.operator}, 'pending',
        ${input.recentCallLimit}, ${input.priorities}::jsonb,
        ${input.result}::jsonb, ${input.triggerType ?? "manual"},
        ${input.executionStartedAt ?? null})
    `;
    return { id, expiresAt: expiresAt.toISOString() };
  }

  async getPlan(id: string) {
    const [row] = await this.sql`
      SELECT id, created_at, expires_at, created_by, status, recent_call_limit,
        priorities, result, applied_at, apply_result, trigger_type, completed_at,
        execution_started_at
      FROM api2business_priority_plans WHERE id=${id}
    `;
    if (!row) throw new Error("priority plan does not exist");
    const plan = row as Record<string, unknown>;
    for (const key of ["priorities", "result", "apply_result"]) {
      if (typeof plan[key] === "string") {
        try { plan[key] = JSON.parse(plan[key] as string); } catch {}
      }
    }
    return plan;
  }

  async markPlanExecutionStarted(id: string) {
    const [row] = await this.sql`
      UPDATE api2business_priority_plans
      SET execution_started_at=COALESCE(execution_started_at, now())
      WHERE id=${id} AND status='pending'
      RETURNING execution_started_at
    `;
    if (!row) throw new Error("priority plan is not pending");
    return row;
  }

  async finishPlan(
    id: string,
    status: "applied" | "failed",
    result: unknown,
    jitterPercent: number,
  ) {
    return await this.sql.begin(async (tx) => {
      const [plan] = await tx`
        UPDATE api2business_priority_plans
        SET status=${status}, applied_at=now(), completed_at=now(),
          execution_started_at=COALESCE(execution_started_at, now()),
          apply_result=${result}::jsonb
        WHERE id=${id}
        RETURNING trigger_type, execution_started_at, completed_at
      `;
      if (!plan) throw new Error("priority plan does not exist");

      let nextRunAt: unknown = null;
      if (plan.trigger_type === "manual") {
        const [automation] = await tx`
          SELECT interval_seconds
          FROM api2business_priority_automation
          WHERE id='default'
          FOR UPDATE
        `;
        if (automation) {
          const nextDelay = jitteredIntervalSeconds(
            Number(automation.interval_seconds),
            jitterPercent,
          );
          const [updated] = await tx`
            UPDATE api2business_priority_automation
            SET next_run_at=now() + make_interval(secs => ${nextDelay}),
              updated_at=now()
            WHERE id='default'
            RETURNING next_run_at
          `;
          nextRunAt = updated?.next_run_at ?? null;
        }
      }
      return {
        execution_started_at: plan.execution_started_at,
        completed_at: plan.completed_at,
        next_run_at: nextRunAt,
      };
    });
  }

  async priorityHistory(limit: number) {
    return await this.sql`
      SELECT id, created_at, execution_started_at, completed_at, created_by,
        trigger_type, status, recent_call_limit, priorities, result, apply_result,
        CASE WHEN completed_at IS NULL THEN NULL
          ELSE EXTRACT(EPOCH FROM (
            completed_at - COALESCE(execution_started_at, created_at)
          )) * 1000
        END AS duration_ms
      FROM api2business_priority_plans
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  async getAutomation() {
    const [row] = await this.sql`
      SELECT id, enabled, interval_seconds, recent_call_limit, next_run_at,
        created_at, updated_at, updated_by, run_id, run_claimed_at, run_started_at,
        last_completed_at, last_run_status
      FROM api2business_priority_automation WHERE id='default'
    `;
    return row ?? null;
  }

  async createAutomation(input: { enabled: boolean; intervalSeconds: number; recentCallLimit: number; operator: string; jitterPercent: number }) {
    const nextDelay = jitteredIntervalSeconds(input.intervalSeconds, input.jitterPercent);
    const [row] = await this.sql`
      INSERT INTO api2business_priority_automation
        (id, enabled, interval_seconds, recent_call_limit, next_run_at, updated_by)
      VALUES ('default', ${input.enabled}, ${input.intervalSeconds}, ${input.recentCallLimit},
        now() + make_interval(secs => ${nextDelay}), ${input.operator})
      RETURNING *
    `;
    return row;
  }

  async updateAutomation(input: { enabled: boolean; intervalSeconds: number; recentCallLimit: number; operator: string; jitterPercent: number }) {
    const nextDelay = jitteredIntervalSeconds(input.intervalSeconds, input.jitterPercent);
    const [row] = await this.sql`
      UPDATE api2business_priority_automation
      SET enabled=${input.enabled}, interval_seconds=${input.intervalSeconds},
        recent_call_limit=${input.recentCallLimit},
        next_run_at=CASE WHEN run_id IS NULL
          THEN now() + make_interval(secs => ${nextDelay})
          ELSE next_run_at END,
        updated_at=now(), updated_by=${input.operator}
      WHERE id='default' RETURNING *
    `;
    if (!row) throw new Error("priority automation does not exist");
    return row;
  }

  async deleteAutomation() {
    const [row] = await this.sql`
      DELETE FROM api2business_priority_automation WHERE id='default' RETURNING id
    `;
    if (!row) throw new Error("priority automation does not exist");
    return row;
  }

  async claimDueAutomation(runTimeoutMs: number, jitterPercent: number) {
    return await this.sql.begin(async (tx) => {
      const [row] = await tx`
        SELECT id, enabled, interval_seconds, recent_call_limit, next_run_at,
          run_id, run_claimed_at, run_started_at, updated_at,
          next_run_at <= now() AS due,
          COALESCE(run_started_at, run_claimed_at, updated_at)
            <= now() - (${runTimeoutMs} * interval '1 millisecond') AS run_expired
        FROM api2business_priority_automation
        WHERE id='default'
        FOR UPDATE SKIP LOCKED
      `;
      if (!row) return null;
      if (row.run_id) {
        if (row.run_expired !== true) return null;
        const runId = String(row.run_id);
        const [pendingPlan] = await tx`
          SELECT id FROM api2business_priority_plans
          WHERE trigger_type='automatic' AND status='pending'
            AND execution_started_at=${row.run_started_at ?? null}
          ORDER BY created_at DESC LIMIT 1
          FOR UPDATE
        `;
        const recoveryResult = {
          changedCount: 0,
          writeMode: "cycle-timeout",
          reason: "automation-run-timeout",
          runTimeoutMs,
        };
        if (pendingPlan) {
          await tx`
            UPDATE api2business_priority_plans
            SET status='failed', applied_at=now(), completed_at=now(),
              apply_result=${recoveryResult}::jsonb
            WHERE id=${pendingPlan.id}
          `;
        }
        const nextDelay = jitteredIntervalSeconds(Number(row.interval_seconds), jitterPercent);
        const [recovered] = await tx`
          UPDATE api2business_priority_automation
          SET run_id=NULL, run_claimed_at=NULL, run_started_at=NULL,
            last_completed_at=now(), last_run_status='failed',
            next_run_at=now() + make_interval(secs => ${nextDelay}), updated_at=now()
          WHERE id='default' AND run_id=${runId}
          RETURNING next_run_at, last_completed_at
        `;
        await tx`
          INSERT INTO api2business_operation_audit
            (id, action, status, operator, input_summary, result_summary)
          VALUES (${crypto.randomUUID()}, 'priority.automation.run', 'failed', 'scheduler',
            ${{ runTimeoutMs }}::jsonb,
            ${{ planId: pendingPlan?.id ?? null, ...recoveryResult }}::jsonb)
        `;
        return {
          recovered: true,
          plan_id: pendingPlan?.id ?? null,
          next_run_at: recovered?.next_run_at ?? null,
          last_completed_at: recovered?.last_completed_at ?? null,
          ...recoveryResult,
        };
      }
      if (row.enabled !== true || row.due !== true) return null;
      const runId = crypto.randomUUID();
      const [claimed] = await tx`
        UPDATE api2business_priority_automation
        SET run_id=${runId}, run_claimed_at=now(), run_started_at=NULL,
          updated_at=now()
        WHERE id='default'
        RETURNING id, enabled, interval_seconds, recent_call_limit,
          next_run_at, run_id, run_claimed_at, run_started_at
      `;
      return claimed ?? null;
    });
  }

  async markAutomationRunStarted(runId: string) {
    const [row] = await this.sql`
      UPDATE api2business_priority_automation
      SET run_started_at=COALESCE(run_started_at, now()), updated_at=now()
      WHERE id='default' AND run_id=${runId}
      RETURNING id, run_id, run_started_at
    `;
    if (!row) throw new Error("priority automation run token no longer exists");
    return row;
  }

  async completeAutomationRun(runId: string, jitterPercent: number, status: string) {
    return await this.sql.begin(async (tx) => {
      const [row] = await tx`
        SELECT interval_seconds
        FROM api2business_priority_automation
        WHERE id='default' AND run_id=${runId}
        FOR UPDATE
      `;
      if (!row) return null;
      const nextDelay = jitteredIntervalSeconds(Number(row.interval_seconds), jitterPercent);
      const [completed] = await tx`
        UPDATE api2business_priority_automation
        SET run_id=NULL, run_claimed_at=NULL, run_started_at=NULL, last_completed_at=now(),
          last_run_status=${status},
          next_run_at=now() + make_interval(secs => ${nextDelay}),
          updated_at=now()
        WHERE id='default' AND run_id=${runId}
        RETURNING id, enabled, interval_seconds, recent_call_limit,
          next_run_at, last_completed_at, last_run_status
      `;
      return completed ?? null;
    });
  }

  async deferDueAutomationAfterDispatchFailure(jitterPercent: number, error: string) {
    return await this.sql.begin(async (tx) => {
      const [row] = await tx`
        SELECT interval_seconds
        FROM api2business_priority_automation
        WHERE id='default' AND enabled=true AND run_id IS NULL AND next_run_at <= now()
        FOR UPDATE SKIP LOCKED
      `;
      if (!row) return null;
      const nextDelay = jitteredIntervalSeconds(Number(row.interval_seconds), jitterPercent);
      const [deferred] = await tx`
        UPDATE api2business_priority_automation
        SET last_completed_at=now(), last_run_status='dispatch-failed',
          next_run_at=now() + make_interval(secs => ${nextDelay}), updated_at=now()
        WHERE id='default' AND run_id IS NULL
        RETURNING id, interval_seconds, recent_call_limit, next_run_at,
          last_completed_at, last_run_status
      `;
      await tx`
        INSERT INTO api2business_operation_audit
          (id, action, status, operator, input_summary, result_summary)
        VALUES (${crypto.randomUUID()}, 'priority.automation.run', 'failed', 'scheduler',
          ${{ stage: "temporal-dispatch" }}::jsonb,
          ${{ reason: "temporal-dispatch-failed", error }}::jsonb)
      `;
      return deferred ?? null;
    });
  }

  async audit(action: string, status: string, operator: string, input: unknown, result: unknown) {
    await this.sql`
      INSERT INTO api2business_operation_audit
        (id, action, status, operator, input_summary, result_summary)
      VALUES (${crypto.randomUUID()}, ${action}, ${status}, ${operator},
        ${input}::jsonb, ${result}::jsonb)
    `;
  }

  async audits(limit: number, offset: number) {
    return await this.sql`
      SELECT id, action, status, operator, input_summary, result_summary, created_at,
        COUNT(*) OVER()::int AS total_count
      FROM api2business_operation_audit ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
  }

  async auditCount() {
    const [row] = await this.sql`SELECT COUNT(*)::int AS total_count FROM api2business_operation_audit`;
    return Number(row?.total_count ?? 0);
  }
}
