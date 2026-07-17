import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import type { AppConfig } from "./config";
import type { AppCommand, OperationRequest } from "./contracts";

export function temporalAddress(config: AppConfig): string {
  const address = process.env[config.temporal.addressEnv];
  if (!address) throw new Error(`Temporal address requires env ${config.temporal.addressEnv}`);
  return address;
}

export class TemporalGateway {
  private constructor(
    private readonly connection: Connection,
    private readonly client: Client,
    private readonly config: AppConfig,
  ) {}

  static async connect(config: AppConfig): Promise<TemporalGateway> {
    const connection = await Connection.connect({ address: temporalAddress(config) });
    return new TemporalGateway(connection, new Client({ connection, namespace: config.temporal.namespace }), config);
  }

  async execute(command: AppCommand): Promise<unknown> {
    const submitted = await this.submit(command);
    return await this.client.workflow.getHandle(submitted.workflowId).result();
  }

  async submit(command: AppCommand): Promise<{ ok: true; workflowId: string; runId: string; state: "submitted" }> {
    const operation: OperationRequest = { operationId: randomUUID(), command };
    const handle = await this.client.workflow.start("operationWorkflow", {
      taskQueue: this.config.temporal.taskQueue,
      workflowId: `apistate-${command.kind.replaceAll(".", "-")}-${operation.operationId}`,
      workflowExecutionTimeout: this.config.temporal.workflowExecutionTimeout,
      args: [{
        operation,
        activityStartToCloseTimeout: this.config.temporal.activityStartToCloseTimeout,
        maximumAttempts: this.config.temporal.retry.maximumAttempts,
      }],
    });
    return { ok: true, workflowId: handle.workflowId, runId: handle.firstExecutionRunId, state: "submitted" };
  }

  async status(workflowId: string): Promise<Record<string, unknown>> {
    const handle = this.client.workflow.getHandle(workflowId);
    const description = await handle.describe();
    const state = description.status.name.toLocaleLowerCase("en-US");
    const terminal = ["completed", "failed", "cancelled", "terminated", "timed_out"].includes(state);
    let result: unknown = null;
    let error: string | null = null;
    if (state === "completed") result = await handle.result();
    else if (terminal) {
      try { await handle.result(); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    }
    return { ok: state === "completed" || !terminal, workflowId, runId: description.runId, state, terminal, result, error };
  }

  async ensureScoreSchedule(): Promise<{ started: boolean; workflowId: string }> {
    const workflowId = this.config.temporal.scoreScheduleWorkflowId;
    try {
      await this.client.workflow.start("scoreRefreshScheduleWorkflow", {
        taskQueue: this.config.temporal.taskQueue,
        workflowId,
        args: [{
          intervalMs: this.config.monitor.refreshIntervalMinutes * 60_000,
          activityStartToCloseTimeout: this.config.temporal.activityStartToCloseTimeout,
          maximumAttempts: this.config.temporal.retry.maximumAttempts,
        }],
      });
      return { started: true, workflowId };
    } catch (error) {
      if (error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError") return { started: false, workflowId };
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}
