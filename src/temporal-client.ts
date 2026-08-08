import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import type { AppConfig } from "./config";
import type { AppCommand, OperationRequest } from "./contracts";

function errorField(error: unknown, field: "name" | "message" | "code"): string | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;
}

export function temporalErrorDetails(error: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = {
    name: errorField(error, "name"),
    code: errorField(error, "code"),
    message: errorField(error, "message") ?? String(error).slice(0, 500),
  };
  const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : null;
  if (cause && cause !== error) details.cause = {
    name: errorField(cause, "name"),
    code: errorField(cause, "code"),
    message: errorField(cause, "message") ?? String(cause).slice(0, 500),
  };
  return details;
}

export class TemporalSubmissionError extends Error {
  readonly details: Record<string, unknown>;
  constructor(error: unknown) {
    const details = temporalErrorDetails(error);
    const cause = details.cause as Record<string, unknown> | undefined;
    const reason = String(cause?.message ?? details.message ?? "unknown Temporal error");
    super(`Temporal 作业提交失败：${reason}`, { cause });
    this.name = "TemporalSubmissionError";
    this.details = details;
  }
}

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
    private readonly runtime: { taskQueue: string; scoreScheduleWorkflowId: string },
  ) {}

  static async connect(config: AppConfig, runtime: { taskQueue: string; scoreScheduleWorkflowId?: string }): Promise<TemporalGateway> {
    const connection = await Connection.connect({ address: temporalAddress(config) });
    return new TemporalGateway(connection, new Client({ connection, namespace: config.temporal.namespace }), config, {
      taskQueue: runtime.taskQueue,
      scoreScheduleWorkflowId: runtime.scoreScheduleWorkflowId ?? config.temporal.scoreScheduleWorkflowId,
    });
  }

  async execute(command: AppCommand): Promise<unknown> {
    const submitted = await this.submit(command);
    return await this.client.workflow.getHandle(submitted.workflowId).result();
  }

  async submit(command: AppCommand): Promise<{ ok: true; workflowId: string; runId: string; state: "submitted" }> {
    const operation: OperationRequest = { operationId: randomUUID(), command };
    let handle;
    try {
      handle = await this.connection.withDeadline(
        Date.now() + this.config.temporal.submissionTimeoutMs,
        async () => await this.client.workflow.start("operationWorkflow", {
          taskQueue: this.runtime.taskQueue,
          workflowId: `api2business-${command.kind.replaceAll(".", "-")}-${operation.operationId}`,
          workflowExecutionTimeout: this.config.temporal.workflowExecutionTimeout,
          args: [{
            operation,
            activityStartToCloseTimeout: this.config.temporal.activityStartToCloseTimeout,
            maximumAttempts: this.config.temporal.retry.maximumAttempts,
          }],
        }),
      );
    } catch (error) {
      throw new TemporalSubmissionError(error);
    }
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
    const legacyWorkflowId = this.runtime.scoreScheduleWorkflowId;
    const workflowId = `${legacyWorkflowId}-snapshot-${this.config.monitor.refreshIntervalMinutes}m-v1`;
    try {
      const legacy = this.client.workflow.getHandle(legacyWorkflowId);
      const description = await legacy.describe();
      if (description.status.name === "RUNNING") {
        await legacy.terminate("migrated to versioned PostgreSQL snapshot schedule");
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "WorkflowNotFoundError")) throw error;
    }
    try {
      await this.client.workflow.start("scoreRefreshScheduleWorkflow", {
        taskQueue: this.runtime.taskQueue,
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

  async ensureUpstreamQuotaSchedule(): Promise<{ started: boolean; workflowId: string }> {
    const legacyWorkflowId = `${this.runtime.scoreScheduleWorkflowId}-upstream-quota`;
    const workflowId = `${legacyWorkflowId}-v3`;
    for (const previousWorkflowId of [legacyWorkflowId, `${legacyWorkflowId}-v2`]) {
      try {
        const previous = this.client.workflow.getHandle(previousWorkflowId);
        const description = await previous.describe();
        if (description.status.name === "RUNNING") {
          await previous.terminate("migrated to independently bounded upstream sampling schedule v3");
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === "WorkflowNotFoundError")) throw error;
      }
    }
    try {
      await this.client.workflow.start("upstreamQuotaScheduleWorkflow", {
        taskQueue: this.runtime.taskQueue, workflowId,
        args: [{ intervalMs: this.config.operations.upstreamManagement.quotaSampleIntervalSeconds * 1000,
          roundTimeoutMs: this.config.operations.upstreamManagement.quotaSampleTimeoutSeconds * 1000,
          activityStartToCloseTimeout: this.config.temporal.activityStartToCloseTimeout,
          maximumAttempts: this.config.temporal.retry.maximumAttempts }],
      });
      return { started: true, workflowId };
    } catch (error) {
      if (error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError") return { started: false, workflowId };
      throw error;
    }
  }

  async ensureIdleProbeSchedule(): Promise<{ started: boolean; workflowId: string; provisionWorkflowId: string }> {
    const workflowId = `${this.runtime.scoreScheduleWorkflowId}-idle-account-probe-v4`;
    const provisionWorkflowId = `${this.runtime.scoreScheduleWorkflowId}-idle-account-provision-v1`;
    if (!this.config.sub2api.idleProbe.enabled) {
      for (const id of [workflowId, provisionWorkflowId]) {
        try {
          const handle = this.client.workflow.getHandle(id);
          const description = await handle.describe();
          if (description.status.name === "RUNNING") await handle.terminate("idle probe disabled by configuration");
        } catch (error) {
          if (!(error instanceof Error && error.name === "WorkflowNotFoundError")) throw error;
        }
      }
      return { started: false, workflowId, provisionWorkflowId };
    }
    for (const legacySuffix of ["idle-account-probe-v2", "idle-account-probe-v3"]) {
      try {
        const legacy = this.client.workflow.getHandle(`${this.runtime.scoreScheduleWorkflowId}-${legacySuffix}`);
        const description = await legacy.describe();
        if (description.status.name === "RUNNING") await legacy.terminate("migrated to independent probe and provision workflows");
      } catch (error) {
        if (!(error instanceof Error && error.name === "WorkflowNotFoundError")) throw error;
      }
    }
    try {
      const provision = this.client.workflow.getHandle(provisionWorkflowId);
      const description = await provision.describe();
      if (description.status.name === "RUNNING") {
        await provision.terminate("probe isolation provisioning is manual-only");
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "WorkflowNotFoundError")) throw error;
    }
    const input = {
      intervalMs: this.config.sub2api.idleProbe.intervalSeconds * 1000,
      roundTimeoutMs: this.config.sub2api.idleProbe.roundTimeoutSeconds * 1000,
      provisionTimeoutMs: this.config.sub2api.idleProbe.provisionTimeoutSeconds * 1000,
      activityStartToCloseTimeout: `${this.config.sub2api.idleProbe.roundTimeoutSeconds}s`,
      maximumAttempts: 1,
    };
    let started = false;
    await this.connection.withDeadline(Date.now() + this.config.temporal.submissionTimeoutMs, async () => {
      try {
        await this.client.workflow.start("idleAccountProbeScheduleWorkflow", {
          taskQueue: this.runtime.taskQueue,
          workflowId,
          args: [input],
        });
        started = true;
      } catch (error) {
        if (!(error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError")) throw error;
      }
    });
    return { started, workflowId, provisionWorkflowId };
  }

  async replaceIdleProbeSchedule(reason: string): Promise<{
    started: true;
    workflowId: string;
    provisionWorkflowId: string;
  }> {
    if (!this.config.sub2api.idleProbe.enabled) throw new Error("idle probe is disabled by configuration");
    const workflowId = `${this.runtime.scoreScheduleWorkflowId}-idle-account-probe-v4`;
    const provisionWorkflowId = `${this.runtime.scoreScheduleWorkflowId}-idle-account-provision-v1`;
    const input = {
      intervalMs: this.config.sub2api.idleProbe.intervalSeconds * 1000,
      roundTimeoutMs: this.config.sub2api.idleProbe.roundTimeoutSeconds * 1000,
      provisionTimeoutMs: this.config.sub2api.idleProbe.provisionTimeoutSeconds * 1000,
      activityStartToCloseTimeout: `${this.config.sub2api.idleProbe.roundTimeoutSeconds}s`,
      maximumAttempts: 1,
    };
    await this.connection.withDeadline(Date.now() + this.config.temporal.submissionTimeoutMs, async () => {
      try {
        const provision = this.client.workflow.getHandle(provisionWorkflowId);
        const description = await provision.describe();
        if (description.status.name === "RUNNING") {
          await provision.terminate("probe isolation provisioning is manual-only");
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === "WorkflowNotFoundError")) throw error;
      }
      await this.client.workflow.start("idleAccountProbeScheduleWorkflow", {
        taskQueue: this.runtime.taskQueue,
        workflowId,
        workflowIdConflictPolicy: "TERMINATE_EXISTING",
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [input],
        memo: { recoveryReason: reason.slice(0, 500) },
      });
    });
    return { started: true, workflowId, provisionWorkflowId };
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}
