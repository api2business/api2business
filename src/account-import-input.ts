import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_JSON_FILES = 100;

export interface NormalizedAccountImportInput {
  content: string;
  accountCount: number;
  fingerprint: string;
  source: { format: "json" | "zip"; jsonFileCount: number; duplicateAccountCount: number };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJson(content: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error(`${label} JSON 内容格式无效`); }
  const payload = object(value);
  if (!payload || !Array.isArray(payload.accounts) || !Array.isArray(payload.proxies)) {
    throw new Error(`${label} 必须是包含 accounts 和 proxies 数组的 Sub2API JSON`);
  }
  return payload;
}

function accountIdentity(account: unknown): string {
  const credentials = object(object(account)?.credentials);
  const userId = typeof credentials?.chatgpt_user_id === "string" ? credentials.chatgpt_user_id.trim() : "";
  if (userId) return `user:${userId}`;
  const accessToken = typeof credentials?.access_token === "string" ? credentials.access_token.trim() : "";
  return accessToken ? `access:${createHash("sha256").update(accessToken).digest("hex")}` : "";
}

function canonicalize(payloads: Record<string, unknown>[], format: "json" | "zip"): NormalizedAccountImportInput {
  const accounts: unknown[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const payload of payloads) {
    for (const account of payload.accounts as unknown[]) {
      const identity = accountIdentity(account);
      if (identity && seen.has(identity)) { duplicates += 1; continue; }
      if (identity) seen.add(identity);
      accounts.push(account);
    }
  }
  if (accounts.length < 1 || accounts.length > 100) throw new Error("去重后的账号数量必须为 1 至 100");
  const content = JSON.stringify({ accounts, proxies: [] });
  return {
    content,
    accountCount: accounts.length,
    fingerprint: createHash("sha256").update(content).digest("hex").slice(0, 16),
    source: { format, jsonFileCount: payloads.length, duplicateAccountCount: duplicates },
  };
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s/gu, "");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("ZIP 内容不是有效的 base64");
  }
  const data = Buffer.from(normalized, "base64");
  if (data.byteLength < 4 || data.byteLength > MAX_INPUT_BYTES) throw new Error("ZIP 文件必须为 1 字节至 10 MiB");
  return data;
}

export function normalizeAccountImportInput(content: string, format: "json" | "zip" = "json"): NormalizedAccountImportInput {
  if (format === "json") {
    if (Buffer.byteLength(content, "utf8") > MAX_INPUT_BYTES) throw new Error("JSON 文件不能超过 10 MiB");
    return canonicalize([parseJson(content, "输入")], "json");
  }
  const data = decodeBase64(content);
  let totalOriginalBytes = 0;
  let jsonFileCount = 0;
  const files = unzipSync(data, {
    filter: (file) => {
      const unsafe = file.name.includes("\0") || file.name.startsWith("/")
        || file.name.split(/[\\/]/u).some((part) => part === "..");
      if (unsafe) throw new Error("ZIP 包含不安全路径");
      if (file.name.endsWith("/") || !file.name.toLowerCase().endsWith(".json")) return false;
      jsonFileCount += 1;
      totalOriginalBytes += file.originalSize;
      if (jsonFileCount > MAX_JSON_FILES) throw new Error("ZIP 内 JSON 文件不能超过 100 个");
      if (totalOriginalBytes > MAX_INPUT_BYTES) throw new Error("ZIP 解压后的 JSON 总大小不能超过 10 MiB");
      return true;
    },
  });
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) throw new Error("ZIP 内没有 JSON 文件");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const payloads = entries.map(([name, bytes]) => parseJson(decoder.decode(bytes), name));
  return canonicalize(payloads, "zip");
}
