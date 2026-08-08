import { continueAsNew, log, proxyActivities, sleep, workflowInfo } from "@temporalio/workflow";
import type { AppCommand, OperationRequest, ScheduledIdleProbeInput, ScheduledScoreRefreshInput, ScheduledUpstreamQuotaInput, WorkflowOptions } from "./contracts";

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
    const stages: Array<{ name: string; command: AppCommand }> = [
      { name: "oauth-runtime", command: { kind: "oauth.runtime.sample" } },
      { name: "upstream-usage", command: { kind: "upstream.usage.sample" } },
      { name: "pool-quality", command: { kind: "pool.quality.sample" } },
    ];
    const results = await Promise.allSettled(stages.map(async (stage) => await activity.executeOperation({
      operationId: `${workflowInfo().runId}:upstream-quota:${iteration}:${stage.name}`,
      command: stage.command,
    })));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "rejected") log.warn("upstream sampling stage deferred to next round", {
        iteration,
        stage: stages[index]?.name ?? `stage-${index}`,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
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
