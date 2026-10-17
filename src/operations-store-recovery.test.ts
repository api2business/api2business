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

test("额度历史以时间索引回读完整窗口、锚点和最近轮次，不扫描全部历史正文", async () => {
  let queryText = "";
  const store = new OperationsStore("postgres://fixture", () => sqlClient(async sql => {
    queryText = sql;
    return [];
  }));
  try {
    await store.getUpstreamQuotaSamples(9);
    expect(queryText).toContain("JOIN (");
    expect(queryText).toContain("selected_rounds USING (sampled_at)");
    expect(queryText).toContain("SELECT DISTINCT ON (wallet_key) sampled_at");
    expect(queryText).toContain("WHERE probe_ok=true AND remaining_usd IS NOT NULL");
    expect(queryText).toContain("ORDER BY sampled_at DESC LIMIT 13");
    expect(queryText.match(/\bUNION\b/gu)).toHaveLength(2);
    expect(queryText).not.toContain("OR sampled_at IN");
  } finally { await store.close(); }
});

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
  expect(queuePools).toBe(1);
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


test("cancels a hung history read and recovers once without recycling the priority lock pool", async () => {
  let pools = 0;
  let cancellations = 0;
  const store = new OperationsStore("postgres://fixture", (_url, max) => {
    if (max === 1) return sqlClient(async () => []);
    const generation = ++pools;
    const client = (() => generation === 1
      ? Object.assign(new Promise<unknown[]>(() => {}), { cancel: () => { cancellations += 1; } })
      : Promise.resolve([{ id: "history" }])) as unknown as FakeSql;
    client.close = async () => undefined;
    return client as unknown as SQL;
  }, false, 5);
  try {
    expect(await store.priorityHistory(10)).toEqual([{ id: "history" }]);
    expect(cancellations).toBe(1);
    expect(pools).toBe(2);
    expect(store.connectionStatus()).toMatchObject({ readTimeouts: 1, connectionRecycles: 1 });
    await store.health();
  } finally { await store.close(); }
});

test("a permanently hung database returns a bounded error and retires the retry pool", async () => {
  let pools = 0;
  const store = new OperationsStore("postgres://fixture", (_url, max) => {
    if (max === 1) return sqlClient(async () => []);
    pools += 1;
    return sqlClient(() => new Promise(() => {}));
  }, false, 5);
  try {
    await expect(store.health()).rejects.toMatchObject({ name: "operations_read_timeout" });
    expect(pools).toBe(3);
    expect(store.connectionStatus()).toMatchObject({ readTimeouts: 2, connectionRecycles: 2 });
  } finally { await store.close(); }
});

test("历史费率读取挂起后重建连接并重试，不阻断观测报告", async () => {
  let pools = 0;
  const store = new OperationsStore("postgres://fixture", (_url, max) => {
    if (max === 1) return sqlClient(async () => []);
    const generation = ++pools;
    return sqlClient(() => generation === 1 ? new Promise(() => {}) : Promise.resolve([{ account_id: 1495, rate_cny: 0.2 }]));
  }, false, 5);
  try {
    expect(await store.observedCostRates("2026-10-16T08:44:00Z", "2026-10-16T10:44:00Z")).toEqual([{ account_id: 1495, rate_cny: 0.2 }]);
    expect(store.connectionStatus()).toMatchObject({ readTimeouts: 1, connectionRecycles: 1 });
  } finally { await store.close(); }
});

for (const kind of ["http", "heartbeat", "retention"] as const) {
  test(`观测${kind}写入挂起有界失败，保留未确认写入且不重放`, async () => {
    let pools = 0;
    let writes = 0;
    const store = new OperationsStore("postgres://fixture", (_url, max) => {
      if (max === 1) return sqlClient(async () => []);
      const generation = ++pools;
      return sqlClient(async (sql) => {
        if (generation === 1 && ((kind === "http" && sql.includes("INSERT INTO api2business_http_observations")) || (kind === "heartbeat" && sql.includes("INSERT INTO api2business_observer_instances")) || (kind === "retention" && sql.includes("DELETE FROM api2business_http_observations")))) {
          writes++;
          return await new Promise(() => {});
        }
        return [];
      });
    }, false, 5);
    try {
      const operation = kind === "http" ? store.observeHttp("2026-10-16T10:44:00Z", "fixture", "/health", 200, 1) : store.observeInstance("fixture", "2026-10-16T10:44:00Z", 0, 7);
      await expect(operation).rejects.toMatchObject({ name: "operations_read_timeout" });
      expect(writes).toBe(1);
      expect(store.connectionStatus()).toMatchObject({ readTimeouts: 1, connectionRecycles: 1 });
      await store.health();
    } finally { await store.close(); }
  });
}
