import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_JSON_FILES = 100;

export interface NormalizedAccountImportInput {
  content: string;
  accountCount: number;
  fingerprint: string;
  platform: "openai" | "grok";
  accountType: "oauth" | "apikey";
  source: { format: "json" | "zip"; jsonFileCount: number; duplicateAccountCount: number; platform: "openai" | "grok"; accountType: "oauth" | "apikey" };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function payload(value: unknown, label: string): Record<string, unknown> {
  const payload = object(value);
  if (!payload || !Array.isArray(payload.accounts) || !Array.isArray(payload.proxies)) {
    throw new Error(`${label} 必须是包含 accounts 和 proxies 数组的 Sub2API JSON`);
  }
  return payload;
}

function parseJson(content: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error(`${label} JSON 内容格式无效`); }
  return payload(value, label);
}

function parseJsonPayloads(content: string): Record<string, unknown>[] {
  try {
    const value = JSON.parse(content) as unknown;
    if (Array.isArray(value)) {
      if (value.length === 0) throw new Error("输入 JSON 数组不能为空");
      return value.map((item, index) => payload(item, `输入[${index + 1}]`));
    }
    return [payload(value, "输入")];
  } catch (error) {
    const lines = content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) throw error;
    return lines.map((line, index) => parseJson(line, `输入第 ${index + 1} 行`));
  }
}

function accountIdentity(account: unknown): string {
  const credentials = object(object(account)?.credentials);
  const userId = typeof credentials?.chatgpt_user_id === "string" ? credentials.chatgpt_user_id.trim() : "";
  if (userId) return `user:${userId}`;
  const accessToken = typeof credentials?.access_token === "string" ? credentials.access_token.trim() : "";
  return accessToken ? `access:${createHash("sha256").update(accessToken).digest("hex")}` : "";
}

function accountPlatform(account: unknown): "openai" | "grok" {
  const value = String(object(account)?.platform ?? "").trim().toLowerCase();
  if (value === "openai") return "openai";
  if (value === "grok") return "grok";
  throw new Error(`账号 platform 只允许 openai 或 grok，收到 ${value || "空值"}`);
}

function accountType(account: unknown): "oauth" | "apikey" {
  const value = String(object(account)?.type ?? "oauth").trim().toLowerCase();
  if (value === "oauth" || value === "apikey") return value;
  throw new Error(`账号 type 只允许 oauth 或 apikey，收到 ${value || "空值"}`);
}

function canonicalize(payloads: Record<string, unknown>[], format: "json" | "zip"): NormalizedAccountImportInput {
  const accounts: unknown[] = [];
  const platforms = new Set<"openai" | "grok">();
  const accountTypes = new Set<"oauth" | "apikey">();
  const seen = new Set<string>();
  let duplicates = 0;
  for (const payload of payloads) {
    for (const account of payload.accounts as unknown[]) {
      platforms.add(accountPlatform(account));
      accountTypes.add(accountType(account));
      const identity = accountIdentity(account);
      if (identity && seen.has(identity)) { duplicates += 1; continue; }
      if (identity) seen.add(identity);
      accounts.push(account);
    }
  }
  if (accounts.length < 1 || accounts.length > 100) throw new Error("去重后的账号数量必须为 1 至 100");
  if (platforms.size !== 1) throw new Error("同一导入批次不能混合 openai 和 grok 账号");
  if (accountTypes.size !== 1) throw new Error("同一导入批次不能混合 OAuth 和 API Key 账号");
  const platform = [...platforms][0]!;
  const selectedAccountType = [...accountTypes][0]!;
  const content = JSON.stringify({ accounts, proxies: [] });
  return {
    content,
    accountCount: accounts.length,
    fingerprint: createHash("sha256").update(content).digest("hex").slice(0, 16),
    platform,
    accountType: selectedAccountType,
    source: { format, jsonFileCount: payloads.length, duplicateAccountCount: duplicates, platform, accountType: selectedAccountType },
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
    return canonicalize(parseJsonPayloads(content), "json");
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
