import { continueAsNew, proxyActivities, sleep, workflowInfo } from "@temporalio/workflow";
import type { OperationRequest, ScheduledScoreRefreshInput, WorkflowOptions } from "./contracts";

export interface Activities {
  executeOperation(request: OperationRequest): Promise<unknown>;
}

interface OperationWorkflowInput extends WorkflowOptions {
  operation: OperationRequest;
}

function activities(options: WorkflowOptions): Activities {
  return proxyActivities<Activities>({
    startToCloseTimeout: options.activityStartToCloseTimeout,
    retry: { maximumAttempts: options.maximumAttempts },
  });
}

export async function operationWorkflow(input: OperationWorkflowInput): Promise<unknown> {
  return await activities(input).executeOperation(input.operation);
}

export async function scoreRefreshScheduleWorkflow(input: ScheduledScoreRefreshInput): Promise<void> {
  const activity = activities(input);
  for (let iteration = 0; iteration < 500; iteration += 1) {
    await activity.executeOperation({
      operationId: `${workflowInfo().runId}:${iteration}`,
      command: { kind: "scores.refresh" },
    });
    await sleep(input.intervalMs);
  }
  await continueAsNew<typeof scoreRefreshScheduleWorkflow>(input);
}
