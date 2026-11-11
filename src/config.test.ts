import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { loadConfig } from "./config";

const configDir = resolve(import.meta.dir, "../config");

type ExampleConfig = {
  operations: {
    upstreamSchedulingV2: {
      scopes: Record<string, Record<string, unknown>>;
    };
  };
};

function loadExampleWithOpencode(platform: string) {
  const raw = parse(readFileSync(join(configDir, "api2business.example.yaml"), "utf8")) as ExampleConfig;
  const codex = raw.operations.upstreamSchedulingV2.scopes.codex;
  raw.operations.upstreamSchedulingV2.scopes.opencode = {
    ...codex,
    platform,
    eligibleGroupIds: [191],
  };
  const path = join(configDir, `.platform-validation-${process.pid}-${Date.now()}.yaml`);
  writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
  try {
    return loadConfig(path);
  } finally {
    rmSync(path, { force: true });
  }
}

describe("upstream scheduling v2 platform validation", () => {
  test("accepts a configured opencode_go scope alongside built-in platforms", () => {
    const config = loadExampleWithOpencode("opencode_go");
    expect(config.operations.upstreamSchedulingV2?.scopes.opencode.platform).toBe("opencode_go");
  });

  test("rejects an unsupported platform identifier", () => {
    expect(() => loadExampleWithOpencode("opencode")).toThrow(
      "operations.upstreamSchedulingV2.scopes.opencode.platform must be openai, anthropic, grok, deepseek, or opencode_go",
    );
  });
});
