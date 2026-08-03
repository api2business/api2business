import { continueAsNew, proxyActivities, sleep, workflowInfo } from "@temporalio/workflow";
import type { OperationRequest, ScheduledIdleProbeInput, ScheduledScoreRefreshInput, ScheduledUpstreamQuotaInput, WorkflowOptions } from "./contracts";
import { remainingScheduleDelayMs } from "./schedule-cadence";

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
    const roundStartedAt = Date.now();
    try {
      await activity.executeOperation({
        operationId: `${workflowInfo().runId}:upstream-quota:${iteration}`,
        command: { kind: "upstream.quota.sample" },
      });
    } catch {
      // API 短暂重载不能终止长期采样循环。
    }
    await sleep(remainingScheduleDelayMs(input.intervalMs, Date.now() - roundStartedAt));
  }
  await continueAsNew<typeof upstreamQuotaScheduleWorkflow>(input);
}

export async function idleAccountProbeScheduleWorkflow(input: ScheduledIdleProbeInput): Promise<void> {
  const probeActivity = proxyActivities<Activities>({
    startToCloseTimeout: input.roundTimeoutMs,
    scheduleToCloseTimeout: input.roundTimeoutMs,
    retry: { maximumAttempts: 1 },
  });
  const provisionActivity = proxyActivities<Activities>({
    startToCloseTimeout: input.provisionTimeoutMs,
    scheduleToCloseTimeout: input.provisionTimeoutMs,
    retry: { maximumAttempts: 1 },
  });
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const roundStartedAt = Date.now();
    try {
      await probeActivity.executeOperation({
        operationId: `${workflowInfo().runId}:idle-probe:${iteration}`,
        command: { kind: "account.idle-probe.run", accountIds: [], rounds: 1 },
      });
    } catch {
      // 单轮失败直接跳过，下一分钟重新选择仍无请求的账号。
    }
    try {
      await provisionActivity.executeOperation({
        operationId: `${workflowInfo().runId}:idle-probe-reconcile:${iteration}`,
        command: { kind: "account.idle-probe.reconcile", accountIds: [] },
      });
    } catch {
      // 慢初始化放在探活之后，失败不影响本轮已有账号采样。
    }
    await sleep(remainingScheduleDelayMs(input.intervalMs, Date.now() - roundStartedAt));
  }
  await continueAsNew<typeof idleAccountProbeScheduleWorkflow>(input);
}
