import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type ApiKeyCutoffTrigger = "manual" | "account-import" | "bugteam-import";

export interface ApiKeyCutoffEvent {
  id: string;
  operationId: string;
  occurredAt: string;
  action: "cutoff" | "restore";
  beforeCount: number;
  afterCount: number;
  trigger: ApiKeyCutoffTrigger;
  durationSeconds: number;
  restoreReason?: string;
  result: "success";
}

export function readApiKeyCutoffEvents(path: string, limit = 100): ApiKeyCutoffEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as ApiKeyCutoffEvent]; }
    catch { return []; }
  }).slice(-limit);
}

export function recordApiKeyCutoffEvent(path: string, event: ApiKeyCutoffEvent): void {
  if (readApiKeyCutoffEvents(path).some((row) => row.id === event.id)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
