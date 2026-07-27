import { SQL } from "bun";

export type CashDirection = "income" | "expense";

export class OperationsStore {
  private readonly sql: SQL;

  constructor(databaseUrl: string) {
    this.sql = new SQL(databaseUrl, { max: 4 });
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
    await this.sql.close();
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

  async createPlan(input: { operator: string; recentCallLimit: number; ttlMinutes: number; priorities: Record<string, number>; result: unknown }) {
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
    await this.sql`
      INSERT INTO apistate_priority_plans
        (id, expires_at, created_by, status, recent_call_limit, priorities, result)
      VALUES (${id}, ${expiresAt}, ${input.operator}, 'pending',
        ${input.recentCallLimit}, ${JSON.stringify(input.priorities)}::jsonb,
        ${JSON.stringify(input.result)}::jsonb)
    `;
    return { id, expiresAt: expiresAt.toISOString() };
  }

  async getPlan(id: string) {
    const [row] = await this.sql`
      SELECT id, created_at, expires_at, created_by, status, recent_call_limit,
        priorities, result, applied_at, apply_result
      FROM apistate_priority_plans WHERE id=${id}
    `;
    if (!row) throw new Error("priority plan does not exist");
    return row as Record<string, unknown>;
  }

  async finishPlan(id: string, status: "applied" | "failed", result: unknown) {
    await this.sql`
      UPDATE apistate_priority_plans SET status=${status}, applied_at=now(),
        apply_result=${JSON.stringify(result)}::jsonb WHERE id=${id}
    `;
  }

  async audit(action: string, status: string, operator: string, input: unknown, result: unknown) {
    await this.sql`
      INSERT INTO apistate_operation_audit
        (id, action, status, operator, input_summary, result_summary)
      VALUES (${crypto.randomUUID()}, ${action}, ${status}, ${operator},
        ${JSON.stringify(input)}::jsonb, ${JSON.stringify(result)}::jsonb)
    `;
  }

  async audits(limit: number) {
    return await this.sql`
      SELECT id, action, status, operator, input_summary, result_summary, created_at
      FROM apistate_operation_audit ORDER BY created_at DESC LIMIT ${limit}
    `;
  }
}
