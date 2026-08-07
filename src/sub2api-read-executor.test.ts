import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import {
  SingleConnectionSub2ApiReadExecutor,
  type ScoreDatabaseLike,
} from "./sub2api-read-executor";

type QueryHook = (
  sql: string,
  parameters: unknown[],
) => Promise<Array<Record<string, unknown>>>;

class FakeDatabase implements ScoreDatabaseLike {
  activeQueries = 0;
  maximumActiveQueries = 0;
  queryCount = 0;
  closed = false;

  constructor(private readonly hook: QueryHook) {}

  async begin<T>(
    callback: (
      transaction: {
        unsafe(sql: string, parameters?: unknown[]): Promise<unknown>;
      },
    ) => Promise<T>,
  ): Promise<T> {
    return await callback({
      unsafe: async (sql, parameters = []) => {
        if (!sql.trimStart().startsWith("SELECT")) return [];
        this.queryCount += 1;
        this.activeQueries += 1;
        this.maximumActiveQueries = Math.max(
          this.maximumActiveQueries,
          this.activeQueries,
        );
        try {
          return await this.hook(sql, parameters);
        } finally {
          this.activeQueries -= 1;
        }
      },
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function options(overrides: Partial<{
  statementTimeoutMs: number;
  queueTimeoutMs: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
}> = {}) {
  return {
    statementTimeoutMs: 100,
    queueTimeoutMs: 100,
    cacheTtlMs: 0,
    cacheMaxEntries: 4,
    ...overrides,
  };
}

function request(
  key: string,
  priority: "manual" | "automatic" = "manual",
) {
  return {
    key,
    kind: key,
    sql: `SELECT '${key}'`,
    parameters: [],
    priority,
    cacheMode: "bypass-cache" as const,
  };
}

test("serializes all queries and lets queued manual work pass automatic work", async () => {
  const order: string[] = [];
  let releaseBlocker!: () => void;
  const blocker = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const database = new FakeDatabase(async (sql) => {
    const key = sql.match(/SELECT '([^']+)'/u)?.[1] ?? "unknown";
    order.push(key);
    if (key === "automatic-blocker") await blocker;
    return [{ key }];
  });
  const executor = new SingleConnectionSub2ApiReadExecutor(
    "postgres://fixture",
    options(),
    database,
  );

  const first = executor.query(request("automatic-blocker", "automatic"));
  await Bun.sleep(1);
  const second = executor.query(request("automatic-waiting", "automatic"));
  const manual = executor.query(request("manual-waiting", "manual"));
  releaseBlocker();
  await Promise.all([first, second, manual]);

  expect(order).toEqual([
    "automatic-blocker",
    "manual-waiting",
    "automatic-waiting",
  ]);
  expect(database.maximumActiveQueries).toBe(1);
  expect(executor.status().maximumObservedDatabaseConcurrency).toBe(1);
  await executor.close();
});

test("deduplicates identical queued or active queries", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const database = new FakeDatabase(async () => {
    await waiting;
    return [{ value: 1 }];
  });
  const executor = new SingleConnectionSub2ApiReadExecutor(
    "postgres://fixture",
    options(),
    database,
  );

  const first = executor.query(request("same"));
  const duplicate = executor.query(request("same"));
  release();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

  expect(database.queryCount).toBe(1);
  expect(firstResult.deduplicated).toBeFalse();
  expect(duplicateResult.deduplicated).toBeTrue();
  expect(executor.status().deduplicatedQueries).toBe(1);
  await executor.close();
});

test("returns a queue timeout without opening a waiting transaction", async () => {
  let blockerStarted!: () => void;
  const started = new Promise<void>((resolve) => { blockerStarted = resolve; });
  const database = new FakeDatabase(async (sql) => {
    if (sql.includes("blocker")) {
      blockerStarted();
      await Bun.sleep(40);
    }
    return [];
  });
  const executor = new SingleConnectionSub2ApiReadExecutor(
    "postgres://fixture",
    options({ queueTimeoutMs: 10 }),
    database,
  );

  const blocker = executor.query(request("blocker"));
  await started;
  const waiting = executor.query(request("waiting"));
  await expect(waiting).rejects.toMatchObject({
    name: "sub2api_read_queue_timeout",
  });
  await blocker;

  expect(database.queryCount).toBe(1);
  expect(executor.status().queueTimeouts).toBe(1);
  await executor.close();
});

test("maps PostgreSQL statement timeout to a stable query timeout", async () => {
  const database = new FakeDatabase(async () => {
    throw new Error("canceling statement due to statement timeout");
  });
  const executor = new SingleConnectionSub2ApiReadExecutor(
    "postgres://fixture",
    options(),
    database,
  );

  await expect(executor.query(request("timeout"))).rejects.toMatchObject({
    name: "sub2api_read_query_timeout",
  });
  expect(executor.status().queryTimeouts).toBe(1);
  await executor.close();
});

test("recycles a closed connection and retries the logical query once", async () => {
  const database = new FakeDatabase(async () => {
    if (database.queryCount === 1) throw new Error("Connection closed");
    return [{ value: 1 }];
  });
  const executor = new SingleConnectionSub2ApiReadExecutor(
    "postgres://fixture",
    options(),
    database,
  );

  const result = await executor.query(request("recover-connection"));

  expect(result.rows).toEqual([{ value: 1 }]);
  expect(database.queryCount).toBe(2);
  expect(executor.status()).toMatchObject({
    totalQueries: 1,
    failedQueries: 0,
    connectionRecycles: 1,
  });
  await executor.close();
});

test("does not retry SQL errors that are unrelated to the connection", async () => {
  const database = new FakeDatabase(async () => {
    throw new Error("column missing_value does not exist");
  });
  const executor = new SingleConnectionSub2ApiReadExecutor(
    "postgres://fixture",
    options(),
    database,
  );

  await expect(executor.query(request("invalid-sql"))).rejects.toMatchObject({
    name: "sub2api_read_failed",
  });
  expect(database.queryCount).toBe(1);
  expect(executor.status().connectionRecycles).toBe(0);
  await executor.close();
});

test("bounds a transaction that hangs before PostgreSQL statement timeout can start", async () => {
  const database = new FakeDatabase(async () => await new Promise<Array<Record<string, unknown>>>(() => undefined));
  const executor = new SingleConnectionSub2ApiReadExecutor(
    "postgres://fixture",
    options({ statementTimeoutMs: 5 }),
    database,
  );

  await expect(executor.query(request("hung-transaction"))).rejects.toMatchObject({
    name: "sub2api_read_query_timeout",
  });
  expect(executor.status()).toMatchObject({ active: false, activeKind: null, queryTimeouts: 1 });
  await executor.close();
});

test("uses the bounded successful-result cache without a second database query", async () => {
  const database = new FakeDatabase(async () => [{ value: 1 }]);
  const executor = new SingleConnectionSub2ApiReadExecutor(
    "postgres://fixture",
    options({ cacheTtlMs: 1000 }),
    database,
  );
  const cachedRequest = {
    ...request("cached"),
    cacheMode: "prefer-cache" as const,
  };

  const first = await executor.query(cachedRequest);
  const second = await executor.query(cachedRequest);

  expect(first.cached).toBeFalse();
  expect(second.cached).toBeTrue();
  expect(database.queryCount).toBe(1);
  expect(executor.status().cacheHits).toBe(1);
  await executor.close();
});

test("worker and CLI keep the Sub2API database owner in the API read broker", () => {
  const worker = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
  const cli = readFileSync(
    new URL("../skills/api2business/scripts/src/cli.ts", import.meta.url),
    "utf8",
  );

  for (const source of [worker, cli]) {
    expect(source).not.toContain("score-database-pool");
    expect(source).not.toContain("new SQL(");
    expect(source).not.toContain("readSecret(config, config.sub2api.scoreDatabase");
    expect(source).not.toContain("scoreDatabaseUrlEnv");
  }
  expect(worker).toContain("OperationsStore");
  expect(worker).not.toContain("createServerContext");
  expect(worker).toContain(
    "const temporalAddressValue = process.env[config.temporal.addressEnv]",
  );
  expect(worker).toContain("else await standaloneStop");
});
