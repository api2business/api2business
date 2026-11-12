import { expect, test } from "bun:test";
import {
  automaticModelSyncAllowed,
  automaticModelSyncScopeNames,
  normalizeModelMapping,
  type ModelSyncPolicy,
} from "./model-sync-policy";

const policy: ModelSyncPolicy = {
  automaticDisabledPlatforms: ["deepseek", "opencode_go", "command_code"],
  canonicalModels: {
    "deepseek-v4.1-flash": {
      aliases: [
        "DeepSeek-V4.1-Flash-1017",
        "DeepSeek-V4.1-Flash",
        "deepseek-v4.1-flash-1017",
      ],
    },
  },
};

function scope(platform: string, modelSyncAutomation = true) {
  return {
    enabled: true,
    platform,
    features: { modelSyncAutomation },
  };
}

test("blocks automatic model sync for DeepSeek, OpenCode, and CommandCode", () => {
  expect(automaticModelSyncAllowed(scope("deepseek"), policy)).toBe(false);
  expect(automaticModelSyncAllowed(scope("opencode_go"), policy)).toBe(false);
  expect(automaticModelSyncAllowed(scope("command_code"), policy)).toBe(false);
  expect(automaticModelSyncAllowed(scope("openai"), policy)).toBe(true);
});

test("worker-facing scope filter creates plans only for allowed platforms", () => {
  expect(automaticModelSyncScopeNames({
    modelSyncPolicy: policy,
    scopes: {
      codex: scope("openai"),
      deepseek: scope("deepseek"),
      opencode: scope("opencode_go"),
      commandcode: scope("command_code"),
      claude: scope("anthropic", false),
    },
  })).toEqual(["codex"]);
});

test("does not open automatic model sync when policy is absent", () => {
  expect(automaticModelSyncAllowed(scope("openai"), undefined)).toBe(false);
});

test("normalizes DeepSeek aliases to the canonical key and available canonical id", () => {
  expect(normalizeModelMapping(
    ["DeepSeek-V4.1-Flash-1017", "DeepSeek-V4.1-Flash", "deepseek-v4.1-flash", "other-model"],
    "deepseek",
    policy,
  )).toEqual({
    "other-model": "other-model",
    "deepseek-v4.1-flash": "deepseek-v4.1-flash",
  });
});

test("uses the 1017 upstream id only when no canonical id exists", () => {
  expect(normalizeModelMapping(
    ["DeepSeek-V4.1-Flash-1017", "other-model"],
    "deepseek",
    policy,
  )).toEqual({
    "other-model": "other-model",
    "deepseek-v4.1-flash": "DeepSeek-V4.1-Flash-1017",
  });
});

test("uses the prefixed canonical id for CommandCode", () => {
  expect(normalizeModelMapping(
    ["DeepSeek-V4.1-Flash", "deepseek/deepseek-v4.1-flash"],
    "command_code",
    policy,
  )).toEqual({
    "deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash",
  });
});

test("uses the account's actual upstream id for OpenCode", () => {
  expect(normalizeModelMapping(
    ["DeepSeek-V4.1-Flash-1017", "glm-5.1"],
    "opencode_go",
    policy,
  )).toEqual({
    "glm-5.1": "glm-5.1",
    "deepseek-v4.1-flash": "DeepSeek-V4.1-Flash-1017",
  });
});

test("normalization is idempotent and preserves unrelated models", () => {
  const models = ["DeepSeek-V4.1-Flash", "glm-5.1"];
  const once = normalizeModelMapping(models, "deepseek", policy);
  const twice = normalizeModelMapping(models, "deepseek", policy);
  expect(twice).toEqual(once);
  expect(once["glm-5.1"]).toBe("glm-5.1");
});
