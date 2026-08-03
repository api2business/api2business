import { SQL } from "bun";

export type Sub2ApiReadPriority = "manual" | "automatic";
export type Sub2ApiReadCacheMode = "prefer-cache" | "bypass-cache";

export interface Sub2ApiReadRequest {
  key: string;
  kind: string;
  sql: string;
  parameters: unknown[];
  priority?: Sub2ApiReadPriority;
  cacheMode?: Sub2ApiReadCacheMode;
  setupStatements?: string[];
}

export interface Sub2ApiReadResult<Row extends Record<string, unknown>> {
  rows: Row[];
  queueDurationMs: number;
  queryDurationMs: number;
  totalDurationMs: number;
  queryStartedAt: string;
  queryCompletedAt: string;
  deduplicated: boolean;
  cached: boolean;
}

export interface Sub2ApiReadStatus {
  owner: "native-api";
  applicationName: "apistate-read-broker";
  connectionLimit: 1;
  queueDepth: number;
  manualQueueDepth: number;
  automaticQueueDepth: number;
  active: boolean;
  activeKind: string | null;
  activeStartedAt: string | null;
  totalQueries: number;
  deduplicatedQueries: number;
  cacheHits: number;
  queueTimeouts: number;
  queryTimeouts: number;
  connectionRecycles: number;
  failedQueries: number;
  maximumObservedDatabaseConcurrency: number;
  lastCompletedAt: string | null;
  lastError: string | null;
}

export interface Sub2ApiReadClient {
  query<Row extends Record<string, unknown>>(
    request: Sub2ApiReadRequest,
  ): Promise<Sub2ApiReadResult<Row>>;
  status(): Sub2ApiReadStatus;
}

interface TransactionLike {
  unsafe(sql: string, parameters?: unknown[]): Promise<unknown>;
}

export interface ScoreDatabaseLike {
  begin<T>(callback: (transaction: TransactionLike) => Promise<T>): Promise<T>;
  close(options?: { timeout?: number }): Promise<void>;
}

interface ExecutorOptions {
  statementTimeoutMs: number;
  queueTimeoutMs: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
}

interface CacheEntry {
  expiresAt: number;
  result: Sub2ApiReadResult<Record<string, unknown>>;
}

interface QueueTask<Row extends Record<string, unknown>> {
  request: Required<Pick<Sub2ApiReadRequest, "key" | "kind" | "sql" | "parameters">>
    & Pick<Sub2ApiReadRequest, "setupStatements">
    & {
      priority: Sub2ApiReadPriority;
      cacheMode: Sub2ApiReadCacheMode;
    };
  queuedAt: number;
  started: boolean;
  cancelled: boolean;
  resolve(value: Sub2ApiReadResult<Row>): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

function roundedDuration(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codedError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`);
  error.name = code;
  return error;
}

export class SingleConnectionSub2ApiReadExecutor implements Sub2ApiReadClient {
  private database: ScoreDatabaseLike;
  private readonly databaseOverride: boolean;
  private readonly manualQueue: Array<QueueTask<Record<string, unknown>>> = [];
  private readonly automaticQueue: Array<QueueTask<Record<string, unknown>>> = [];
  private readonly inFlight = new Map<string, Promise<Sub2ApiReadResult<Record<string, unknown>>>>();
  private readonly cache = new Map<string, CacheEntry>();
  private activeTask: QueueTask<Record<string, unknown>> | null = null;
  private draining = false;
  private closed = false;
  private activeDatabaseQueries = 0;
  private metrics: Omit<
    Sub2ApiReadStatus,
    | "owner"
    | "applicationName"
    | "connectionLimit"
    | "queueDepth"
    | "manualQueueDepth"
    | "automaticQueueDepth"
    | "active"
    | "activeKind"
    | "activeStartedAt"
  > = {
    totalQueries: 0,
    deduplicatedQueries: 0,
    cacheHits: 0,
    queueTimeouts: 0,
    queryTimeouts: 0,
    connectionRecycles: 0,
    failedQueries: 0,
    maximumObservedDatabaseConcurrency: 0,
    lastCompletedAt: null,
    lastError: null,
  };
  private activeStartedAt: string | null = null;

  constructor(
    private readonly databaseUrl: string,
    private readonly options: ExecutorOptions,
    databaseOverride?: ScoreDatabaseLike,
  ) {
    if (!this.databaseUrl.trim()) throw new Error("Sub2API read executor requires a database URL");
    this.databaseOverride = databaseOverride !== undefined;
    this.database = databaseOverride
      ?? this.createDatabase(this.databaseUrl);
  }

  query<Row extends Record<string, unknown>>(
    input: Sub2ApiReadRequest,
  ): Promise<Sub2ApiReadResult<Row>> {
    if (this.closed) {
      return Promise.reject(codedError("sub2api_read_closed", "Sub2API read executor is closed"));
    }
    if (!input.key.trim() || !input.kind.trim() || !input.sql.trim()) {
      return Promise.reject(codedError(
        "sub2api_read_invalid_request",
        "read key, kind, and SQL must be non-empty",
      ));
    }
    const cacheMode = input.cacheMode ?? "prefer-cache";
    const cached = cacheMode === "prefer-cache" ? this.cached<Row>(input.key) : null;
    if (cached) return Promise.resolve(cached);

    const existing = this.inFlight.get(input.key);
    if (existing) {
      this.metrics.deduplicatedQueries += 1;
      return existing.then((result) => ({
        ...result,
        rows: result.rows as Row[],
        deduplicated: true,
      }));
    }

    const request = {
      key: input.key,
      kind: input.kind,
      sql: input.sql,
      parameters: input.parameters,
      setupStatements: input.setupStatements,
      priority: input.priority ?? "manual",
      cacheMode,
    };
    let task!: QueueTask<Row>;
    const promise = new Promise<Sub2ApiReadResult<Row>>((resolve, reject) => {
      task = {
        request,
        queuedAt: performance.now(),
        started: false,
        cancelled: false,
        resolve,
        reject,
        timeout: setTimeout(() => {
          if (task.started || task.cancelled) return;
          task.cancelled = true;
          this.metrics.queueTimeouts += 1;
          const error = codedError(
            "sub2api_read_queue_timeout",
            `query ${request.kind} exceeded ${this.options.queueTimeoutMs}ms in queue`,
          );
          this.metrics.lastError = error.message;
          reject(error);
        }, this.options.queueTimeoutMs),
      };
      const queue = request.priority === "manual" ? this.manualQueue : this.automaticQueue;
      queue.push(task as QueueTask<Record<string, unknown>>);
    });
    const shared = promise as Promise<Sub2ApiReadResult<Record<string, unknown>>>;
    this.inFlight.set(input.key, shared);
    void shared.finally(() => {
      if (this.inFlight.get(input.key) === shared) this.inFlight.delete(input.key);
    }).catch(() => undefined);
    void this.drain();
    return promise;
  }

  status(): Sub2ApiReadStatus {
    return {
      owner: "native-api",
      applicationName: "apistate-read-broker",
      connectionLimit: 1,
      queueDepth: this.manualQueue.length + this.automaticQueue.length,
      manualQueueDepth: this.manualQueue.length,
      automaticQueueDepth: this.automaticQueue.length,
      active: this.activeTask !== null,
      activeKind: this.activeTask?.request.kind ?? null,
      activeStartedAt: this.activeStartedAt,
      ...this.metrics,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = codedError("sub2api_read_closed", "Sub2API read executor is closing");
    for (const task of [...this.manualQueue, ...this.automaticQueue]) {
      if (task.cancelled || task.started) continue;
      task.cancelled = true;
      clearTimeout(task.timeout);
      task.reject(error);
    }
    this.manualQueue.length = 0;
    this.automaticQueue.length = 0;
    while (this.activeTask !== null) await Bun.sleep(10);
    await this.database.close();
  }

  private cached<Row extends Record<string, unknown>>(
    key: string,
  ): Sub2ApiReadResult<Row> | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.metrics.cacheHits += 1;
    return {
      ...entry.result,
      rows: entry.result.rows as Row[],
      queueDurationMs: 0,
      totalDurationMs: 0,
      deduplicated: false,
      cached: true,
    };
  }

  private remember(
    key: string,
    result: Sub2ApiReadResult<Record<string, unknown>>,
  ): void {
    if (this.options.cacheTtlMs <= 0) return;
    this.cache.delete(key);
    this.cache.set(key, {
      expiresAt: Date.now() + this.options.cacheTtlMs,
      result: { ...result, rows: [...result.rows] },
    });
    while (this.cache.size > this.options.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private nextTask(): QueueTask<Record<string, unknown>> | null {
    for (const queue of [this.manualQueue, this.automaticQueue]) {
      while (queue.length > 0) {
        const task = queue.shift()!;
        if (task.cancelled) continue;
        return task;
      }
    }
    return null;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed) {
        const task = this.nextTask();
        if (!task) break;
        await this.execute(task);
      }
    } finally {
      this.draining = false;
      if (!this.closed && (this.manualQueue.length > 0 || this.automaticQueue.length > 0)) {
        void this.drain();
      }
    }
  }

  private async execute(task: QueueTask<Record<string, unknown>>): Promise<void> {
    task.started = true;
    clearTimeout(task.timeout);
    this.activeTask = task;
    this.activeStartedAt = new Date().toISOString();
    const totalStartedAt = performance.now();
    const queueDurationMs = Math.round((performance.now() - task.queuedAt) * 10) / 10;
    let queryStartedAt = new Date().toISOString();
    let queryCompletedAt = queryStartedAt;
    let queryDurationMs = 0;
    try {
      const databaseOperation = this.database.begin(async (transaction) => {
        await transaction.unsafe("SET TRANSACTION READ ONLY");
        await transaction.unsafe(
          `SET LOCAL statement_timeout = '${this.options.statementTimeoutMs}ms'`,
        );
        for (const statement of task.request.setupStatements ?? []) {
          await transaction.unsafe(statement);
        }
        this.activeDatabaseQueries += 1;
        this.metrics.maximumObservedDatabaseConcurrency = Math.max(
          this.metrics.maximumObservedDatabaseConcurrency,
          this.activeDatabaseQueries,
        );
        const queryStartedAtMs = performance.now();
        queryStartedAt = new Date().toISOString();
        try {
          return await transaction.unsafe(
            task.request.sql,
            task.request.parameters,
          ) as Record<string, unknown>[];
        } finally {
          queryDurationMs = roundedDuration(queryStartedAtMs);
          queryCompletedAt = new Date().toISOString();
          this.activeDatabaseQueries -= 1;
        }
      });
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const watchdogTimeout = new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(codedError(
          "sub2api_read_query_timeout",
          `query ${task.request.kind} exceeded ${this.options.statementTimeoutMs}ms before the connection was released`,
        )), this.options.statementTimeoutMs + 1000);
      });
      let rows: Record<string, unknown>[];
      try {
        rows = await Promise.race([databaseOperation, watchdogTimeout]);
      } catch (error) {
        if (error instanceof Error && error.name === "sub2api_read_query_timeout") {
          void databaseOperation.catch(() => undefined);
          await this.recycleDatabase();
        }
        throw error;
      } finally {
        if (watchdog !== null) clearTimeout(watchdog);
      }
      const result: Sub2ApiReadResult<Record<string, unknown>> = {
        rows,
        queueDurationMs,
        queryDurationMs,
        totalDurationMs: roundedDuration(totalStartedAt),
        queryStartedAt,
        queryCompletedAt,
        deduplicated: false,
        cached: false,
      };
      this.metrics.totalQueries += 1;
      this.metrics.lastCompletedAt = queryCompletedAt;
      this.metrics.lastError = null;
      this.remember(task.request.key, result);
      task.resolve(result);
    } catch (error) {
      const message = errorMessage(error);
      const timedOut = (error instanceof Error && error.name === "sub2api_read_query_timeout")
        || /statement timeout|canceling statement due to statement timeout/iu.test(message);
      if (timedOut) this.metrics.queryTimeouts += 1;
      else this.metrics.failedQueries += 1;
      this.metrics.totalQueries += 1;
      this.metrics.lastCompletedAt = new Date().toISOString();
      this.metrics.lastError = message;
      task.reject(timedOut
        ? codedError(
          "sub2api_read_query_timeout",
          `query ${task.request.kind} exceeded ${this.options.statementTimeoutMs}ms`,
        )
        : codedError("sub2api_read_failed", `query ${task.request.kind} failed: ${message}`));
    } finally {
      this.activeTask = null;
      this.activeStartedAt = null;
    }
  }

  private createDatabase(databaseUrl: string): ScoreDatabaseLike {
    return new SQL(databaseUrl, {
      max: 1,
      connection: { application_name: "apistate-read-broker" },
    }) as unknown as ScoreDatabaseLike;
  }

  private async recycleDatabase(): Promise<void> {
    if (this.databaseOverride) return;
    const expired = this.database;
    this.database = this.createDatabase(this.databaseUrl);
    this.metrics.connectionRecycles += 1;
    await Promise.race([
      expired.close({ timeout: 1 }).catch(() => undefined),
      Bun.sleep(1500),
    ]);
  }
}
