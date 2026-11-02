import { expect, test } from "bun:test";
import { assertSchedulingRuntimeQuery, normalizeCliArgs, parseArgs, poolQualityScope, priorityHistoryDiagnostics, selectPriorityHistory, summarizeWorkflowStatus } from "./cli";
import { operationHelp } from "./operation-help";
import { webProbeElementArgs } from "./web-screenshot";

test("historical balance CLI accepts signed USD without consuming the next option", () => {
  const args = ["--config", "config/api2business.yaml", "upstreams", "usage-cache", "restore"];
  for (const remaining of ["-0.00203599", "0", "15.5"]) {
    const parsed = parseArgs([...args, "--remaining-usd", remaining, "--confirm"]);
    expect(parsed.remainingUsd).toBe(Number(remaining));
    expect(parsed.confirm).toBe(true);
    expect(parsed.command).toEqual(["upstreams", "usage-cache", "restore"]);
  }
  for (const invalid of ["--confirm", "NaN", "Infinity", ""]) {
    expect(() => parseArgs([...args, "--remaining-usd", invalid])).toThrow();
  }
  expect(() => parseArgs([...args, "--over-api", "--confirm"])).toThrow();
  const screenshot = parseArgs(["--config", "config/api2business.yaml", "web", "screenshot", "--click-selector", "th[data-sort-key=remaining]", "--selector", "#v2-history-table"]);
  expect(screenshot.clickSelector).toBe("th[data-sort-key=remaining]");
  expect(screenshot.selector).toBe("#v2-history-table");
  expect(screenshot.command).toEqual(["web", "screenshot"]);
  expect(webProbeElementArgs(screenshot.clickSelector, screenshot.selector)).toEqual([
    "--click-selector", "th[data-sort-key=remaining]",
    "--selector", "#v2-history-table",
  ]);
  expect(() => parseArgs(["--config", "config/api2business.yaml", "web", "screenshot", "--selector"])).toThrow("--selector requires a value");
});

test("CLI uses the repository config only when --config is omitted", () => {
  const defaultConfig = "config/api2business.yaml";
  expect(normalizeCliArgs(["scores", "rank"], defaultConfig)).toEqual(["--config", defaultConfig, "scores", "rank"]);
  const explicit = ["--config", "config/custom.yaml", "scores", "rank"];
  expect(normalizeCliArgs(explicit, defaultConfig)).toEqual(explicit);
  expect(normalizeCliArgs(["scores", "rank"], null)).toEqual(["scores", "rank"]);
  expect(() => parseArgs(normalizeCliArgs(["scores", "rank"], null)))
    .toThrow("run from the Api2Business repository root");
});

test("operation help returns action-specific contracts without loading config", () => {
  const reconcile = operationHelp(["accounts", "idle-probe", "--scope", "codex", "reconcile", "--confirm", "--help"]);
  expect(reconcile).toMatchObject({ ok: true, command: "accounts idle-probe reconcile" });
  expect(String(reconcile?.usage)).toContain("accounts idle-probe reconcile");
  expect(String(reconcile?.usage)).toContain("--confirm");
  expect(String(reconcile?.verification)).toContain("coverage");
  expect(JSON.stringify(reconcile)).toContain("仓库根自动读取");

  const coverage = operationHelp(["accounts", "idle-probe", "coverage", "--help"]);
  expect(coverage).toMatchObject({ ok: true, command: "accounts idle-probe coverage" });
  expect(String(coverage?.usage)).toContain("accounts idle-probe coverage");
  expect(String(coverage?.usage)).toContain("--window-minutes");

  const snapshot = operationHelp(["upstream-scheduling-v2", "--scope", "codex", "snapshot", "--help"]);
  expect(snapshot).toMatchObject({ ok: true, command: "upstream-scheduling-v2 snapshot" });
  expect(String(snapshot?.usage)).toContain("--cache-only");
  expect(String(snapshot?.verification)).toContain("complete=true");

  const priorityRun = operationHelp(["upstream-scheduling-v2", "priority-run", "--help"]);
  expect(priorityRun).toMatchObject({ ok: true, command: "upstream-scheduling-v2 priority-run" });
  expect(String(priorityRun?.usage)).toContain("--confirm");

  const rank = operationHelp(["scores", "rank", "--help"]);
  expect(rank).toMatchObject({ ok: true, command: "scores rank" });
  expect(String(rank?.verification)).toContain("refreshedAt");
  expect(operationHelp(["scores", "get", "--help"])).toBeNull();
});

test("priority history scope keeps matching rounds and discloses omissions", () => {
  const selected = selectPriorityHistory({
    ok: true,
    records: [
      { id: "ds", profile: "deepseek", profiles: ["deepseek"], created_by: "v2-scheduler:deepseek" },
      { id: "mixed", profile: "combined", profiles: ["codex", "deepseek"] },
      { id: "cx", profile: "codex", profiles: ["codex"] },
    ],
  }, "deepseek");
  expect(selected.records).toEqual([
    { id: "ds", profile: "deepseek", profiles: ["deepseek"], created_by: "v2-scheduler:deepseek" },
    { id: "mixed", profile: "combined", profiles: ["codex", "deepseek"] },
  ]);
  expect(selected).toMatchObject({ scope: "deepseek", matchedCount: 2, omittedCount: 1 });
  expect(() => selectPriorityHistory({ records: [] }, "openai")).toThrow("codex, claude, grok, or deepseek");
});

test("priority history human diagnostics expose query, snapshot age, block and recovery", () => {
  expect(priorityHistoryDiagnostics({
    score_query_duration_ms: 14731.6,
    score_snapshot_age_seconds: 18300,
    automation_blocked_reasons: ["score-query-slow-or-unknown"],
    recovery_action: "inspect-score-query-and-probe-volume",
  })).toEqual({
    query: "14.73s",
    snapshotAge: "5.1h",
    reason: "score-query-slow-or-unknown",
    recovery: "inspect-score-query-and-probe-volume",
  });
  expect(priorityHistoryDiagnostics({
    failure_reason: "score-query-failed",
    score_error: "sub2api_read_query_timeout: query scores.rank exceeded 15000ms",
  }).reason).toContain("sub2api_read_query_timeout");
});

test("pool quality reads the requested scope and runtime evidence accepts deepseek", () => {
  expect(poolQualityScope(null, null)).toBe("codex");
  expect(poolQualityScope("claude", null)).toBe("claude");
  expect(poolQualityScope(null, "deepseek")).toBe("deepseek");
  expect(poolQualityScope("grok", "grok")).toBe("grok");
  expect(() => poolQualityScope("openai", null)).toThrow("codex|claude|grok|deepseek");
  expect(() => poolQualityScope("codex", "claude")).toThrow("same scope");
  expect(assertSchedulingRuntimeQuery("131", "deepseek")).toEqual({ group: "131", platform: "deepseek" });
  expect(() => assertSchedulingRuntimeQuery("131", "codex")).toThrow("deepseek");
});

test("workflow summary exposes partial initialization and an in-flight probe", () => {
  const summary = summarizeWorkflowStatus({ ok: true, state: "completed", terminal: true,
    result: { ok: false, operation: "initialize", status: "partial", verifiedCount: 1,
      probeVerifiedCount: 0, accounts: [{ accountId: 42, responsesMode: "force_responses" }],
      probes: [{ scope: "codex", skipped: true, reason: "in-flight", verified: false }] } });
  expect(summary).toMatchObject({ resultOk: false, onboardingStatus: "partial", configurationVerified: 1,
    probeVerified: 0, probes: [{ skipped: true, reason: "in-flight" }] });
  expect(summary.nextAction).toContain("upstreams initialize");
});
