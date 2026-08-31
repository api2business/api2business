type Row = Record<string, unknown>;

// 与当前 Sub2API OpenAI 模型白名单保持一致，但刻意排除 gpt-5.6-luna。
const defaultAllowedModels = [
  "gpt-5.2",
  "gpt-5.2-2025-12-11",
  "gpt-5.2-chat-latest",
  "gpt-5.2-pro",
  "gpt-5.2-pro-2025-12-11",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-2026-03-05",
  "gpt-5.3-codex-spark",
  "codex-auto-review",
  "gpt-4o-audio-preview",
  "gpt-4o-realtime-preview",
  "gpt-image-1",
  "gpt-image-1.5",
  "gpt-image-2",
] as const;

function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function hasExplicitModelMapping(value: unknown): boolean {
  const mapping = record(value);
  if (!mapping) return false;
  return Object.entries(mapping).some(([from, to]) => from.trim() !== "" && typeof to === "string" && to.trim() !== "");
}

export function modelMappingForOpenAIOAuthAccount(
  account: Row,
  disableLunaByDefault: boolean,
): Record<string, string> | null {
  const credentials = record(account.credentials) ?? {};
  const explicit = record(credentials.model_mapping);
  if (hasExplicitModelMapping(explicit)) {
    return Object.fromEntries(Object.entries(explicit!).filter(([, value]) => typeof value === "string" && value.trim() !== ""));
  }
  return disableLunaByDefault ? defaultOpenAIOAuthModelMapping() : null;
}

export function defaultOpenAIOAuthModelMapping(): Record<string, string> {
  return Object.fromEntries(defaultAllowedModels.map((model) => [model, model]));
}

export function applyDefaultOpenAIOAuthModelRestriction(content: string, enabled: boolean): string {
  if (!enabled) return content;
  const payload = JSON.parse(content) as Row;
  if (!Array.isArray(payload.accounts)) return content;
  let changed = false;
  const accounts = payload.accounts.map((value) => {
    const account = record(value);
    if (!account || String(account.platform ?? "").trim().toLowerCase() !== "openai"
      || String(account.type ?? "oauth").trim().toLowerCase() !== "oauth") return value;
    const credentials = record(account.credentials) ?? {};
    if (hasExplicitModelMapping(credentials.model_mapping)) return value;
    changed = true;
    return {
      ...account,
      credentials: {
        ...credentials,
        model_mapping: defaultOpenAIOAuthModelMapping(),
      },
    };
  });
  return changed ? JSON.stringify({ ...payload, accounts }) : content;
}
