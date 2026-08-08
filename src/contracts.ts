export type AppCommand =
  | { kind: "backend.check" }
  | { kind: "scores.get" }
  | { kind: "scores.refresh" }
  | { kind: "scores.rank"; recentCallLimit: number; accountSelector: string | null; groupSelector: string | null }
  | { kind: "ranking.get" }
  | { kind: "lottery.publicState" }
  | { kind: "lottery.publicDraw" }
  | { kind: "lottery.status" }
  | { kind: "lottery.draw" }
  | { kind: "lottery.reset"; draws: number; includeRecords: boolean }
  | { kind: "records.list"; limit: number }
  | { kind: "records.delete"; id: string }
  | { kind: "credit.test"; execute: boolean }
  | { kind: "upstream.operation"; operationId: string }
  | { kind: "upstream.quota.sample" }
  | { kind: "upstream.usage.sample" }
  | { kind: "pool.quality.sample" }
  | { kind: "oauth.runtime.sample" }
  | { kind: "upstream.benchmark"; benchmarkRunId: string; accountId: number; model: string }
  | { kind: "account.idle-probe.run"; accountIds: number[]; rounds: number }
  | { kind: "account.idle-probe.reconcile"; accountIds: number[] }
  | { kind: "account.import"; jobId: string }
  | { kind: "account.lifecycle.detect"; jobId: string }
  | { kind: "account.lifecycle.settle"; jobId: string; candidateIds: number[] }
  | { kind: "priority.plan.create"; recentCallLimit: number; operator: string }
  | { kind: "priority.plan.manual-create"; priorities: Record<string, number>; operator: string }
  | { kind: "priority.plan.confirm"; planId: string; operator: string }
  | { kind: "priority.automation.run" };

export interface OperationRequest {
  operationId: string;
  command: AppCommand;
}

export interface WorkflowOptions {
  activityStartToCloseTimeout: string;
  maximumAttempts: number;
}

export interface ScheduledScoreRefreshInput extends WorkflowOptions {
  intervalMs: number;
}
export interface ScheduledUpstreamQuotaInput extends WorkflowOptions {
  intervalMs: number;
  roundTimeoutMs: number;
}
export interface ScheduledIdleProbeInput extends WorkflowOptions {
  intervalMs: number;
  roundTimeoutMs: number;
  provisionTimeoutMs: number;
}

export function usesWorkflow(command: AppCommand): boolean {
  return command.kind === "scores.refresh"
    || command.kind === "lottery.publicDraw"
    || command.kind === "lottery.draw"
    || command.kind === "lottery.reset"
    || command.kind === "records.delete"
    || (command.kind === "credit.test" && command.execute)
    || command.kind === "upstream.operation"
    || command.kind === "upstream.quota.sample"
    || command.kind === "upstream.usage.sample"
    || command.kind === "pool.quality.sample"
    || command.kind === "oauth.runtime.sample"
    || command.kind === "upstream.benchmark"
    || command.kind === "account.idle-probe.run"
    || command.kind === "account.idle-probe.reconcile"
    || command.kind === "account.import"
    || command.kind === "account.lifecycle.detect"
    || command.kind === "account.lifecycle.settle"
    || command.kind === "priority.plan.create"
    || command.kind === "priority.plan.manual-create"
    || command.kind === "priority.plan.confirm"
    || command.kind === "priority.automation.run";
}
