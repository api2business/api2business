import { SQL } from "bun";

const pools = new Map<string, SQL>();

export function scoreDatabasePool(databaseUrl: string): SQL {
  const existing = pools.get(databaseUrl);
  if (existing) return existing;
  const database = new SQL(databaseUrl, { max: 1 });
  pools.set(databaseUrl, database);
  return database;
}

export async function closeScoreDatabasePools(): Promise<void> {
  const databases = [...pools.values()];
  pools.clear();
  await Promise.all(databases.map((database) => database.close()));
}
