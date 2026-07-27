import { afterEach, expect, test } from "bun:test";
import { closeScoreDatabasePools, scoreDatabasePool } from "./score-database-pool";

afterEach(async () => await closeScoreDatabasePools());

test("shares one score database pool per process and authority", () => {
  const first = scoreDatabasePool("postgres://user:pass@127.0.0.1:5432/score");
  const second = scoreDatabasePool("postgres://user:pass@127.0.0.1:5432/score");
  const other = scoreDatabasePool("postgres://user:pass@127.0.0.1:5432/other");
  expect(second).toBe(first);
  expect(other).not.toBe(first);
});
