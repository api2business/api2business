import { expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { normalizeAccountImportInput } from "./account-import-input";

function payload(userId: string): string {
  return JSON.stringify({
    accounts: [{ platform: "openai", type: "oauth", credentials: { chatgpt_user_id: userId, access_token: `token-${userId}` } }],
    proxies: [],
  });
}

test("merges JSON files from ZIP and removes duplicate OAuth identities", () => {
  const zip = zipSync({
    "batch/a.json": strToU8(payload("user-a")),
    "batch/b.json": strToU8(payload("user-b")),
    "batch/duplicate.json": strToU8(payload("user-a")),
    "batch/note.txt": strToU8("ignored"),
  });
  const normalized = normalizeAccountImportInput(Buffer.from(zip).toString("base64"), "zip");
  expect(normalized.accountCount).toBe(2);
  expect(normalized.source).toEqual({ format: "zip", jsonFileCount: 3, duplicateAccountCount: 1, platform: "openai" });
  expect(normalized.platform).toBe("openai");
  expect((JSON.parse(normalized.content) as { accounts: unknown[]; proxies: unknown[] }).accounts).toHaveLength(2);
});

test("rejects unsafe ZIP paths", () => {
  const zip = zipSync({ "../account.json": strToU8(payload("user-a")) });
  expect(() => normalizeAccountImportInput(Buffer.from(zip).toString("base64"), "zip")).toThrow("ZIP 包含不安全路径");
});

test("keeps JSON input compatible while projecting canonical content", () => {
  const normalized = normalizeAccountImportInput(payload("user-a"), "json");
  expect(normalized.accountCount).toBe(1);
  expect(normalized.source).toEqual({ format: "json", jsonFileCount: 1, duplicateAccountCount: 0, platform: "openai" });
});

test("detects Grok JSON and rejects mixed-platform batches", () => {
  const grok = JSON.stringify({ accounts: [{ platform: "grok", type: "oauth", credentials: { account_id: "grok-a", access_token: "grok-token" } }], proxies: [] });
  expect(normalizeAccountImportInput(grok).platform).toBe("grok");
  const mixed = JSON.stringify({
    accounts: [
      { platform: "openai", credentials: { access_token: "openai-token" } },
      { platform: "grok", credentials: { access_token: "grok-token" } },
    ],
    proxies: [],
  });
  expect(() => normalizeAccountImportInput(mixed)).toThrow("不能混合 openai 和 grok");
});
