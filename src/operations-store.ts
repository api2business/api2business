import { SQL } from "bun";
import { jitteredIntervalSeconds } from "./priority-automation-schedule";

export type CashDirection = "income" | "expense";

export interface PriorityOptimizationQueueLease {
  queueName: "priority-optimization-global";
  queuedAt: string;
  acquiredAt: string;
  waitMs: number;
}

export class OperationsStore {
  private readonly sql: SQL;
  private readonly priorityOptimizationQueueSql: SQL;

  constructor(databaseUrl: string) {
    this.sql = new SQL(databaseUrl, { max: 4 });
    this.priorityOptimizationQueueSql = new SQL(databaseUrl, { max: 1 });
  }

  async migrate(): Promise<void> {
    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS apistate_cash_entries (
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
      CREATE TABLE IF NOT EXISTS apistate_priority_plans (
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
      ALTER TABLE apistate_priority_plans
        ADD COLUMN IF NOT EXISTS trigger_type text NOT NULL DEFAULT 'manual';
      ALTER TABLE apistate_priority_plans
        ADD COLUMN IF NOT EXISTS completed_at timestamptz;
      ALTER TABLE apistate_priority_plans
        ADD COLUMN IF NOT EXISTS execution_started_at timestamptz;
      CREATE TABLE IF NOT EXISTS apistate_priority_automation (
        id text PRIMARY KEY CHECK (id='default'),
        enabled boolean NOT NULL,
        interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 5 AND 86400),
        recent_call_limit integer NOT NULL,
        next_run_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text NOT NULL
      );
      ALTER TABLE apistate_priority_automation
        ADD COLUMN IF NOT EXISTS run_id uuid;
      ALTER TABLE apistate_priority_automation
        ADD COLUMN IF NOT EXISTS run_started_at timestamptz;
      ALTER TABLE apistate_priority_automation
        ADD COLUMN IF NOT EXISTS run_claimed_at timestamptz;
      ALTER TABLE apistate_priority_automation
        ADD COLUMN IF NOT EXISTS last_completed_at timestamptz;
      ALTER TABLE apistate_priority_automation
        ADD COLUMN IF NOT EXISTS last_run_status text;
      CREATE TABLE IF NOT EXISTS apistate_operation_audit (
        id uuid PRIMARY KEY,
        action text NOT NULL,
        status text NOT NULL,
        operator text NOT NULL,
        input_summary jsonb NOT NULL,
        result_summary jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS apistate_cash_entries_occurred_on_idx
        ON apistate_cash_entries(occurred_on DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS apistate_operation_audit_created_at_idx
        ON apistate_operation_audit(created_at DESC);
    `);
  }

  async close(): Promise<void> {
    await Promise.all([this.sql.close(), this.priorityOptimizationQueueSql.close()]);
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
          hashtext(${"apistate"}),
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
              hashtext(${"apistate"}),
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
      INSERT INTO apistate_cash_entries
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
      UPDATE apistate_cash_entries
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
      FROM apistate_cash_entries
    `;
    return row ?? { income_cny: 0, expense_cny: 0 };
  }

  async cashDaySummary(day: string) {
    const [row] = await this.sql`
      SELECT
        COUNT(*) FILTER (WHERE voided_at IS NULL)::int AS total_count,
        COALESCE(SUM(amount_cny) FILTER (WHERE direction='income' AND voided_at IS NULL), 0) AS income_cny,
        COALESCE(SUM(amount_cny) FILTER (WHERE direction='expense' AND voided_at IS NULL), 0) AS expense_cny
      FROM apistate_cash_entries
      WHERE occurred_on=${day}
    `;
    return row ?? { total_count: 0, income_cny: 0, expense_cny: 0 };
  }

  async listCashPage(limit: number, offset: number) {
    return await this.sql`
      SELECT id, occurred_on, direction, category, amount_cny, description,
        operator, created_at, voided_at, voided_by, void_reason,
        COUNT(*) OVER()::int AS total_count
      FROM apistate_cash_entries ORDER BY occurred_on DESC, created_at DESC
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
      INSERT INTO apistate_priority_plans
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
      FROM apistate_priority_plans WHERE id=${id}
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
      UPDATE apistate_priority_plans
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
        UPDATE apistate_priority_plans
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
          FROM apistate_priority_automation
          WHERE id='default'
          FOR UPDATE
        `;
        if (automation) {
          const nextDelay = jitteredIntervalSeconds(
            Number(automation.interval_seconds),
            jitterPercent,
          );
          const [updated] = await tx`
            UPDATE apistate_priority_automation
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
      FROM apistate_priority_plans
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  async getAutomation() {
    const [row] = await this.sql`
      SELECT id, enabled, interval_seconds, recent_call_limit, next_run_at,
        created_at, updated_at, updated_by, run_id, run_claimed_at, run_started_at,
        last_completed_at, last_run_status
      FROM apistate_priority_automation WHERE id='default'
    `;
    return row ?? null;
  }

  async createAutomation(input: { enabled: boolean; intervalSeconds: number; recentCallLimit: number; operator: string; jitterPercent: number }) {
    const nextDelay = jitteredIntervalSeconds(input.intervalSeconds, input.jitterPercent);
    const [row] = await this.sql`
      INSERT INTO apistate_priority_automation
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
      UPDATE apistate_priority_automation
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
      DELETE FROM apistate_priority_automation WHERE id='default' RETURNING id
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
        FROM apistate_priority_automation
        WHERE id='default'
        FOR UPDATE SKIP LOCKED
      `;
      if (!row) return null;
      if (row.run_id) {
        if (row.run_expired !== true) return null;
        const runId = String(row.run_id);
        const [pendingPlan] = await tx`
          SELECT id FROM apistate_priority_plans
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
            UPDATE apistate_priority_plans
            SET status='failed', applied_at=now(), completed_at=now(),
              apply_result=${recoveryResult}::jsonb
            WHERE id=${pendingPlan.id}
          `;
        }
        const nextDelay = jitteredIntervalSeconds(Number(row.interval_seconds), jitterPercent);
        const [recovered] = await tx`
          UPDATE apistate_priority_automation
          SET run_id=NULL, run_claimed_at=NULL, run_started_at=NULL,
            last_completed_at=now(), last_run_status='failed',
            next_run_at=now() + make_interval(secs => ${nextDelay}), updated_at=now()
          WHERE id='default' AND run_id=${runId}
          RETURNING next_run_at, last_completed_at
        `;
        await tx`
          INSERT INTO apistate_operation_audit
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
        UPDATE apistate_priority_automation
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
      UPDATE apistate_priority_automation
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
        FROM apistate_priority_automation
        WHERE id='default' AND run_id=${runId}
        FOR UPDATE
      `;
      if (!row) return null;
      const nextDelay = jitteredIntervalSeconds(Number(row.interval_seconds), jitterPercent);
      const [completed] = await tx`
        UPDATE apistate_priority_automation
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

  async audit(action: string, status: string, operator: string, input: unknown, result: unknown) {
    await this.sql`
      INSERT INTO apistate_operation_audit
        (id, action, status, operator, input_summary, result_summary)
      VALUES (${crypto.randomUUID()}, ${action}, ${status}, ${operator},
        ${input}::jsonb, ${result}::jsonb)
    `;
  }

  async audits(limit: number, offset: number) {
    return await this.sql`
      SELECT id, action, status, operator, input_summary, result_summary, created_at,
        COUNT(*) OVER()::int AS total_count
      FROM apistate_operation_audit ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
  }

  async auditCount() {
    const [row] = await this.sql`SELECT COUNT(*)::int AS total_count FROM apistate_operation_audit`;
    return Number(row?.total_count ?? 0);
  }
}
