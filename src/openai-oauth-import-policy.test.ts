import { expect, test } from "bun:test";
import {
  applyDefaultOpenAIOAuthModelRestriction,
  defaultOpenAIOAuthModelMapping,
} from "./openai-oauth-import-policy";

test("adds an OpenAI OAuth whitelist without Luna", () => {
  const content = JSON.stringify({
    accounts: [{ platform: "openai", type: "oauth", credentials: { access_token: "token" } }],
    proxies: [],
  });

  const output = JSON.parse(applyDefaultOpenAIOAuthModelRestriction(content, true)) as {
    accounts: Array<{ credentials: { model_mapping: Record<string, string> } }>;
  };
  const mapping = output.accounts[0]!.credentials.model_mapping;
  expect(mapping).toEqual(defaultOpenAIOAuthModelMapping());
  expect(mapping).not.toHaveProperty("gpt-5.6-luna");
});

test("preserves an explicit OAuth model mapping", () => {
  const content = JSON.stringify({
    accounts: [{
      platform: "openai",
      type: "oauth",
      credentials: { access_token: "token", model_mapping: { "custom-model": "custom-model" } },
    }],
    proxies: [],
  });

  expect(applyDefaultOpenAIOAuthModelRestriction(content, true)).toBe(content);
});

test("can preserve the source mapping for public recovery imports", () => {
  const content = JSON.stringify({
    accounts: [{ platform: "openai", type: "oauth", credentials: { access_token: "token" } }],
    proxies: [],
  });

  expect(applyDefaultOpenAIOAuthModelRestriction(content, false)).toBe(content);
});
