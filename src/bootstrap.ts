import type { AppConfig, EmbeddedCliTarget, ServerTarget } from "./config";
import { resolveDataPath } from "./config";
import { LotteryService } from "./lottery-service";
import { readSub2ApiCredentials } from "./secrets";
import { LotteryStore } from "./store";
import { Sub2ApiClient } from "./sub2api-client";
import { AccountScoreService } from "./account-score-service";
import type { WebAuthSecrets } from "./web-auth";
import type { Sub2ApiReadClient } from "./sub2api-read-executor";
import { Sub2ApiRuntimeService } from "./sub2api-runtime-service";
import type { ScoreSnapshotStore } from "./account-score-service";

export interface AppContext {
  service: LotteryService;
  store: LotteryStore;
  monitor: AccountScoreService;
  auth: WebAuthSecrets;
  runtime: Sub2ApiRuntimeService;
  close(): void;
}

export function createEmbeddedContext(config: AppConfig, target: EmbeddedCliTarget): AppContext {
  const store = new LotteryStore(config, resolveDataPath(config, target.databasePath));
  const client = new Sub2ApiClient(config, readSub2ApiCredentials(config));
  const monitor = new AccountScoreService(config, resolveDataPath(config, target.scoreCachePath), client);
  return {
    service: new LotteryService(config, store, client),
    store,
    monitor,
    auth: { password: "embedded", apiKey: "embedded", sessionSecret: "embedded" },
    runtime: new Sub2ApiRuntimeService(client, config.operations.upstreamManagement.failoverRules),
    close: () => { monitor.close(); store.close(); },
  };
}

export function createServerContext(
  config: AppConfig,
  target: ServerTarget,
  reads: Sub2ApiReadClient,
  snapshotStore: ScoreSnapshotStore,
): AppContext {
  const email = process.env[target.sub2apiAdminEmailEnv];
  const password = process.env[target.sub2apiAdminPasswordEnv];
  const webPassword = process.env[target.webPasswordEnv];
  const apiKey = process.env[target.apiKeyEnv];
  const sessionSecret = process.env[target.sessionSecretEnv];
  if (!email || !password || !webPassword || !apiKey || !sessionSecret) {
    throw new Error("server target is missing one or more declared secret environment keys");
  }
  const store = new LotteryStore(config, resolveDataPath(config, target.databasePath));
  const client = new Sub2ApiClient(config, { email, password });
  const monitor = new AccountScoreService(
    config,
    resolveDataPath(config, target.scoreCachePath),
    client,
    reads,
    snapshotStore,
  );
  return {
    service: new LotteryService(config, store, client, reads),
    store,
    monitor,
    auth: { password: webPassword, apiKey, sessionSecret },
    runtime: new Sub2ApiRuntimeService(client, config.operations.upstreamManagement.failoverRules),
    close: () => { monitor.close(); store.close(); },
  };
}
