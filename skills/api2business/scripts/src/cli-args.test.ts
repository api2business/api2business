import { expect, test } from "bun:test";
import { parseArgs, summarizeWorkflowStatus } from "./cli";

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
  const screenshot = parseArgs(["--config", "config/api2business.yaml", "web", "screenshot", "--click-selector", "th[data-sort-key=remaining]"]);
  expect(screenshot.clickSelector).toBe("th[data-sort-key=remaining]");
  expect(screenshot.command).toEqual(["web", "screenshot"]);
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
