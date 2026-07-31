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
  | { kind: "priority.plan.create"; recentCallLimit: number; operator: string }
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

export function usesWorkflow(command: AppCommand): boolean {
  return command.kind === "scores.refresh"
    || command.kind === "lottery.publicDraw"
    || command.kind === "lottery.draw"
    || command.kind === "lottery.reset"
    || command.kind === "records.delete"
    || (command.kind === "credit.test" && command.execute)
    || command.kind === "upstream.operation"
    || command.kind === "priority.plan.create"
    || command.kind === "priority.plan.confirm"
    || command.kind === "priority.automation.run";
}
