import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { OperationsStore } from "./operations-store";

interface FakeSql extends Function {
  close(): Promise<void>;
}

function sqlClient(query: () => Promise<unknown[]>): SQL {
  const client = (async () => await query()) as unknown as FakeSql;
  client.close = async () => undefined;
  return client as unknown as SQL;
}

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
