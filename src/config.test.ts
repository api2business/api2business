import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { loadConfig } from "./config";

const configDir = resolve(import.meta.dir, "../config");

type ExampleConfig = {
  operations: {
    upstreamSchedulingV2: {
      modelSyncPolicy?: Record<string, unknown>;
      scopes: Record<string, Record<string, unknown>>;
    };
  };
};

function loadExampleWithMutation(mutator: (raw: ExampleConfig) => void) {
  const raw = parse(readFileSync(join(configDir, "api2business.example.yaml"), "utf8")) as ExampleConfig;
  mutator(raw);
  const path = join(configDir, `.platform-validation-${process.pid}-${Date.now()}.yaml`);
  writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
  try {
    return loadConfig(path);
  } finally {
    rmSync(path, { force: true });
  }
}

function loadExampleWithOpencode(platform: string) {
  return loadExampleWithMutation((raw) => {
    const codex = raw.operations.upstreamSchedulingV2.scopes.codex;
    raw.operations.upstreamSchedulingV2.scopes.opencode = {
      ...codex,
      platform,
      eligibleGroupIds: [191],
    };
  });
}

describe("upstream scheduling v2 platform validation", () => {
  test("accepts a configured opencode_go scope alongside built-in platforms", () => {
    const config = loadExampleWithOpencode("opencode_go");
    expect(config.operations.upstreamSchedulingV2?.scopes.opencode.platform).toBe("opencode_go");
  });

  test("rejects an unsupported platform identifier", () => {
    expect(() => loadExampleWithOpencode("opencode")).toThrow(
      "operations.upstreamSchedulingV2.scopes.opencode.platform must be openai, anthropic, grok, deepseek, opencode_go, or command_code",
    );
  });
});

describe("model sync policy validation", () => {
  test.each(["deepseek", "opencode_go", "command_code"])(
    "rejects automatic model sync for disabled platform %s",
    (platform) => {
      expect(() => loadExampleWithMutation((raw) => {
        const codex = raw.operations.upstreamSchedulingV2.scopes.codex;
        raw.operations.upstreamSchedulingV2.scopes[`${platform.replaceAll("_", "-")}-scope`] = {
          ...codex,
          platform,
          features: { ...(codex.features as Record<string, unknown>), modelSyncAutomation: true },
        };
      })).toThrow(`modelSyncAutomation is forbidden for platform ${platform}`);
    },
  );

  test("still allows automatic model sync for OpenAI when policy is present", () => {
    const config = loadExampleWithMutation((raw) => {
      const features = raw.operations.upstreamSchedulingV2.scopes.codex.features as Record<string, unknown>;
      raw.operations.upstreamSchedulingV2.scopes.codex.features = { ...features, modelSyncAutomation: true };
    });
    expect(config.operations.upstreamSchedulingV2?.scopes.codex.features.modelSyncAutomation).toBe(true);
  });

  test("keeps legacy configurations without policy compatible only when automation is off", () => {
    const config = loadExampleWithMutation((raw) => {
      delete raw.operations.upstreamSchedulingV2.modelSyncPolicy;
      for (const scope of Object.values(raw.operations.upstreamSchedulingV2.scopes)) {
        scope.features = { ...(scope.features as Record<string, unknown>), modelSyncAutomation: false };
      }
    });
    expect(config.operations.upstreamSchedulingV2?.modelSyncPolicy).toBeUndefined();
  });

  test("does not silently open automation when policy is absent", () => {
    expect(() => loadExampleWithMutation((raw) => {
      delete raw.operations.upstreamSchedulingV2.modelSyncPolicy;
      const features = raw.operations.upstreamSchedulingV2.scopes.codex.features as Record<string, unknown>;
      raw.operations.upstreamSchedulingV2.scopes.codex.features = { ...features, modelSyncAutomation: true };
    })).toThrow("modelSyncPolicy is required");
  });
});
