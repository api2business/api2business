import type { Sub2ApiSystemLog } from "./sub2api-client";

export interface RuntimePolicyEventBatch {
  events: Sub2ApiSystemLog[];
  evidence: Record<string, unknown>;
}

export interface RuntimePolicyEventSource {
  collect(window: string): Promise<RuntimePolicyEventBatch>;
}
