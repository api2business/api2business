import { SQL } from "bun";
import { jitteredIntervalSeconds } from "./priority-automation-schedule";

export type CashDirection = "income" | "expense";

export interface PriorityWriteQueueLease {
  queueName: "priority-write-global";
  queuedAt: string;
  acquiredAt: string;
  waitMs: number;
}

export class OperationsStore {
  private readonly sql: SQL;
  private readonly priorityWriteQueueSql: SQL;

  constructor(databaseUrl: string) {
    this.sql = new SQL(databaseUrl, { max: 4 });
    this.priorityWriteQueueSql = new SQL(databaseUrl, { max: 1 });
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
    await Promise.all([this.sql.close(), this.priorityWriteQueueSql.close()]);
  }

  async withPriorityWriteQueue<T>(
    operation: (lease: PriorityWriteQueueLease) => Promise<T>,
  ): Promise<T> {
    const queuedAt = new Date().toISOString();
    const queuedAtMs = Date.now();
    const connection = await this.priorityWriteQueueSql.reserve();
    let locked = false;
    let reusable = true;
    try {
      await connection`
        SELECT pg_advisory_lock(
          hashtext(${"apistate"}),
          hashtext(${"priority-write-global"})
        )
      `;
      locked = true;
      const acquiredAt = new Date().toISOString();
      return await operation({
        queueName: "priority-write-global",
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
              hashtext(${"priority-write-global"})
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

  async listCash() {
    return await this.sql`
      SELECT id, occurred_on, direction, category, amount_cny, description,
        operator, created_at, voided_at, voided_by, void_reason
      FROM apistate_cash_entries ORDER BY occurred_on DESC, created_at DESC LIMIT 500
    `;
  }

  async createPlan(input: { operator: string; recentCallLimit: number; ttlMinutes: number; priorities: Record<string, number>; result: unknown; triggerType?: "manual" | "automatic" }) {
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
    await this.sql`
      INSERT INTO apistate_priority_plans
        (id, expires_at, created_by, status, recent_call_limit, priorities, result, trigger_type)
      VALUES (${id}, ${expiresAt}, ${input.operator}, 'pending',
        ${input.recentCallLimit}, ${input.priorities}::jsonb,
        ${input.result}::jsonb, ${input.triggerType ?? "manual"})
    `;
    return { id, expiresAt: expiresAt.toISOString() };
  }

  async getPlan(id: string) {
    const [row] = await this.sql`
      SELECT id, created_at, expires_at, created_by, status, recent_call_limit,
        priorities, result, applied_at, apply_result, trigger_type, completed_at
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

  async finishPlan(id: string, status: "applied" | "failed", result: unknown) {
    await this.sql`
      UPDATE apistate_priority_plans SET status=${status}, applied_at=now(), completed_at=now(),
        apply_result=${result}::jsonb WHERE id=${id}
    `;
  }

  async priorityHistory(limit: number) {
    return await this.sql`
      SELECT id, created_at, completed_at, created_by, trigger_type, status,
        recent_call_limit, priorities, result, apply_result
      FROM apistate_priority_plans
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  async getAutomation() {
    const [row] = await this.sql`
      SELECT id, enabled, interval_seconds, recent_call_limit, next_run_at,
        created_at, updated_at, updated_by, run_id, run_started_at,
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

  async claimDueAutomation() {
    return await this.sql.begin(async (tx) => {
      const [row] = await tx`
        SELECT id, enabled, interval_seconds, recent_call_limit, next_run_at
        FROM apistate_priority_automation
        WHERE id='default' AND enabled=true AND run_id IS NULL
          AND next_run_at <= now()
        FOR UPDATE SKIP LOCKED
      `;
      if (!row) return null;
      const runId = crypto.randomUUID();
      const [claimed] = await tx`
        UPDATE apistate_priority_automation
        SET run_id=${runId}, run_started_at=now(),
          updated_at=now()
        WHERE id='default'
        RETURNING id, enabled, interval_seconds, recent_call_limit,
          next_run_at, run_id, run_started_at
      `;
      return claimed ?? null;
    });
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
        SET run_id=NULL, run_started_at=NULL, last_completed_at=now(),
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

  async audits(limit: number) {
    return await this.sql`
      SELECT id, action, status, operator, input_summary, result_summary, created_at
      FROM apistate_operation_audit ORDER BY created_at DESC LIMIT ${limit}
    `;
  }
}
