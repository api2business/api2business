import { continueAsNew, proxyActivities, sleep, workflowInfo } from "@temporalio/workflow";
import type { OperationRequest, ScheduledIdleProbeInput, ScheduledScoreRefreshInput, ScheduledUpstreamQuotaInput, WorkflowOptions } from "./contracts";

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

export async function upstreamQuotaScheduleWorkflow(input: ScheduledUpstreamQuotaInput): Promise<void> {
  const roundTimeoutMs = input.roundTimeoutMs ?? Math.max(1_000, input.intervalMs - 1_000);
  const activity = proxyActivities<Activities>({
    startToCloseTimeout: roundTimeoutMs,
    scheduleToCloseTimeout: roundTimeoutMs,
    retry: { maximumAttempts: 1 },
  });
  for (let iteration = 0; iteration < 500; iteration += 1) {
    try {
      await activity.executeOperation({
        operationId: `${workflowInfo().runId}:upstream-quota:${iteration}`,
        command: { kind: "upstream.quota.sample" },
      });
    } catch {
      // API 短暂重载不能终止长期采样循环。
    }
    await sleep(input.intervalMs);
  }
  await continueAsNew<typeof upstreamQuotaScheduleWorkflow>(input);
}

export async function idleAccountProbeScheduleWorkflow(input: ScheduledIdleProbeInput): Promise<void> {
  const probeActivity = proxyActivities<Activities>({
    startToCloseTimeout: input.roundTimeoutMs,
    scheduleToCloseTimeout: input.roundTimeoutMs,
    retry: { maximumAttempts: 1 },
  });
  for (let iteration = 0; iteration < 500; iteration += 1) {
    try {
      await probeActivity.executeOperation({
        operationId: `${workflowInfo().runId}:idle-probe:${iteration}`,
        command: { kind: "account.idle-probe.run", accountIds: [], rounds: 1 },
      });
    } catch {
      // 单轮失败直接跳过，下一分钟重新选择仍无请求的账号。
    }
    await sleep(input.intervalMs);
  }
  await continueAsNew<typeof idleAccountProbeScheduleWorkflow>(input);
}

export async function idleAccountProvisionScheduleWorkflow(input: ScheduledIdleProbeInput): Promise<void> {
  const activity = proxyActivities<Activities>({
    startToCloseTimeout: input.provisionTimeoutMs,
    scheduleToCloseTimeout: input.provisionTimeoutMs,
    retry: { maximumAttempts: 1 },
  });
  for (let iteration = 0; iteration < 500; iteration += 1) {
    try {
      await activity.executeOperation({
        operationId: `${workflowInfo().runId}:idle-probe-reconcile:${iteration}`,
        command: { kind: "account.idle-probe.reconcile", accountIds: [] },
      });
    } catch {
      // 单轮初始化失败直接跳过，不影响独立的探活周期。
    }
    await sleep(input.intervalMs);
  }
  await continueAsNew<typeof idleAccountProvisionScheduleWorkflow>(input);
}
