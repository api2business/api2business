import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config";
import type { Sub2ApiSystemLog } from "./sub2api-client";
import { runBoundedProcess } from "./bounded-process";

type Row = Record<string, unknown>;

export interface RuntimePolicyEventBatch {
  events: Sub2ApiSystemLog[];
  evidence: Row;
}

export interface RuntimePolicyEventSource {
  collect(window: string): Promise<RuntimePolicyEventBatch>;
}

function record(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readCliPayload(stdout: string): Row {
  let payload = record(JSON.parse(stdout));
  if (!payload) throw new Error("runtime events CLI returned an invalid payload");
  const outerData = record(payload.data);
  if (outerData?.outputTruncated === true) {
    const dumpPath = text(record(outerData.dump)?.path);
    if (!dumpPath || !dumpPath.startsWith("/tmp/unidesk-cli-output/") || !existsSync(dumpPath)) {
      throw new Error("runtime events CLI did not expose its protected raw result");
    }
    try {
      payload = record(JSON.parse(readFileSync(dumpPath, "utf8")));
    } finally {
      try { unlinkSync(dumpPath); } catch { /* The CLI may clean up its own result. */ }
    }
    if (!payload) throw new Error("runtime events CLI raw result is invalid");
  }
  const response = record(payload.data);
  const parsed = record(response?.parsed);
  if (payload.ok !== true || response?.ok !== true || parsed?.ok !== true) {
    throw new Error(`runtime events CLI failed: ${text(parsed?.error) ?? "unknown error"}`);
  }
  return parsed;
}

export class UniDeskRuntimePolicyEventSource implements RuntimePolicyEventSource {
  constructor(private readonly config: AppConfig, private readonly workDir: string) {}

  async collect(window: string): Promise<RuntimePolicyEventBatch> {
    const args = [
      resolve(this.workDir, this.config.monitor.cli.entrypoint),
      "platform-infra", "sub2api", "codex-pool", "runtime", "events",
      "--target", this.config.monitor.target,
      "--since", window,
      "--raw",
    ];
    const result = await runBoundedProcess([this.config.monitor.cli.executable, ...args], {
      cwd: this.workDir,
      env: { ...Bun.env, UNIDESK_MAIN_SERVER_IP: this.config.monitor.cli.mainServerHost },
      timeoutMs: this.config.monitor.cli.timeoutMs,
      maxOutputBytes: 16 * 1024 * 1024,
    });
    const { stdout, stderr, exitCode } = result;
    if (result.timedOut) throw new Error(`runtime events CLI timed out after ${this.config.monitor.cli.timeoutMs}ms`);
    if (result.stdoutTruncated || result.stderrTruncated) throw new Error("runtime events CLI output exceeded the bounded limit");
    if (exitCode !== 0) throw new Error(`runtime events CLI exited ${exitCode}: ${stderr.trim().slice(-600)}`);
    const payload = readCliPayload(stdout);
    const rows = Array.isArray(payload.events) ? payload.events.map(record).filter((item): item is Row => item !== null) : [];
    const events = rows.map((row, index): Sub2ApiSystemLog => ({
      id: index + 1,
      created_at: text(row.createdAt) ?? "",
      message: text(row.marker) ?? "",
      request_id: text(row.requestId) ?? undefined,
      account_id: numberValue(row.accountId),
      extra: {
        group_id: numberValue(row.groupId),
        status_code: numberValue(row.statusCode),
        upstream_status: numberValue(row.upstreamStatus),
        path: text(row.path),
      },
    }));
    return {
      events,
      evidence: {
        source: payload.source,
        window: payload.window,
        tail: payload.tail,
        scannedLineCount: payload.scannedLineCount,
        policyEventCount: payload.policyEventCount,
        completionEventCount: payload.completionEventCount,
        eventCount: payload.eventCount,
      },
    };
  }
}
