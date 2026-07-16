import type { AppConfig, EmbeddedCliTarget, ServerTarget } from "./config";
import { resolveDataPath } from "./config";
import { LotteryService } from "./lottery-service";
import { readSub2ApiCredentials } from "./secrets";
import { LotteryStore } from "./store";
import { Sub2ApiClient } from "./sub2api-client";

export interface AppContext {
  service: LotteryService;
  store: LotteryStore;
  close(): void;
}

export function createEmbeddedContext(config: AppConfig, target: EmbeddedCliTarget): AppContext {
  const store = new LotteryStore(config, resolveDataPath(config, target.databasePath));
  const client = new Sub2ApiClient(config, readSub2ApiCredentials(config));
  return { service: new LotteryService(config, store, client), store, close: () => store.close() };
}

export function createServerContext(config: AppConfig, target: ServerTarget): AppContext {
  const email = process.env[target.sub2apiAdminEmailEnv];
  const password = process.env[target.sub2apiAdminPasswordEnv];
  if (!email || !password) throw new Error(`server target requires env ${target.sub2apiAdminEmailEnv} and ${target.sub2apiAdminPasswordEnv}`);
  const store = new LotteryStore(config, resolveDataPath(config, target.databasePath));
  const client = new Sub2ApiClient(config, { email, password });
  return { service: new LotteryService(config, store, client), store, close: () => store.close() };
}
