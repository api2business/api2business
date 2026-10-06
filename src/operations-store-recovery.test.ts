import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { OperationsStore } from "./operations-store";
import { isRecoverableDatabaseConnectionError } from "./database-connection";
import { lowWalletRows } from "./upstream-recharge-candidates";

interface FakeSql extends Function {
  close(): Promise<void>;
}

function sqlClient(query: (sql: string) => Promise<unknown[]>): SQL {
  const client = (async (strings: TemplateStringsArray) => await query(strings.join("?"))) as unknown as FakeSql;
  client.close = async () => undefined;
  return client as unknown as SQL;
}

test("成功钱包投影保留probe_ok，低余额候选可以消费真实store返回值", async () => {
  let queryText = "";
  const store = new OperationsStore("postgres://fixture", () => sqlClient(async (sql) => {
    queryText = sql;
    const projection = sql.slice(0, sql.indexOf("FROM api2business_upstream_quota_samples"));
    return [{
      wallet_key: "https://low.example", account_id: 21,
      sampled_at: "2026-10-07T00:00:00Z", remaining_cny: 4,
      account_cost_inputs: [{ accountId: 22 }],
      ...(projection.includes("probe_ok") ? { probe_ok: true } : {}),
    }];
  }));
  try {
    const rows = await store.getLatestSuccessfulUpstreamQuotaSamples();
    expect(queryText).toContain("WHERE probe_ok=true AND remaining_cny IS NOT NULL");
    expect(lowWalletRows(rows, 10, 24).map((row) => row.account_id)).toEqual([21, 22]);
  } finally {
    await store.close();
  }
});

test("rebuilds stale operation pools once and retries cache reads", async () => {
  let mainPools = 0;
  let queuePools = 0;
  let staleQueries = 0;
  const store = new OperationsStore("postgres://fixture", (_url, max) => {
    if (max === 1) {
      queuePools += 1;
      return sqlClient(async () => []);
    }
    mainPools += 1;
    const stale = mainPools === 1;
    return sqlClient(async () => {
      if (stale) {
        staleQueries += 1;
        throw new Error("Connection closed");
      }
      return [{ cache_key: "fixture", status: 200, headers: {}, body: "{}" }];
    });
  });

  const [first, second] = await Promise.all([
    store.getApiCache("first"),
    store.getApiCache("second"),
  ]);

  expect(first?.status).toBe(200);
  expect(second?.status).toBe(200);
  expect(staleQueries).toBe(2);
  expect(mainPools).toBe(2);
  expect(queuePools).toBe(2);
  await store.close();
});

test("does not rebuild operation pools for SQL semantic errors", async () => {
  let mainPools = 0;
  const store = new OperationsStore("postgres://fixture", (_url, max) => {
    if (max === 1) return sqlClient(async () => []);
    mainPools += 1;
    return sqlClient(async () => {
      throw new Error("column missing_value does not exist");
    });
  });

  await expect(store.health()).rejects.toThrow("column missing_value does not exist");
  expect(mainPools).toBe(1);
  await store.close();
});

test("recycles Bun protocol read failures", () => {
  expect(isRecoverableDatabaseConnectionError(new Error("Failed to read data"))).toBeTrue();
  expect(isRecoverableDatabaseConnectionError(Object.assign(new Error("protocol"), { code: "ERR_POSTGRES_INVALID_MESSAGE" }))).toBeTrue();
});
