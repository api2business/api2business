import { readFileSync } from "node:fs";
import type { AppConfig, SecretRef } from "./config";

function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.set(key, value);
  }
  return values;
}

export function readSecret(config: AppConfig, ref: SecretRef): string {
  const path = config.runtime.secretSourcePaths[ref.sourceRef];
  if (!path) throw new Error(`runtime.secretSourcePaths is missing sourceRef ${ref.sourceRef}`);
  const text = readFileSync(path, "utf8");
  const value = ref.sourceKey === "contents" ? text.trim() : parseEnv(text).get(ref.sourceKey);
  if (!value) throw new Error(`secret source ${ref.sourceRef} is missing key ${ref.sourceKey}`);
  return value;
}

export function readSub2ApiCredentials(config: AppConfig): { email: string; password: string } {
  const sourceRef = config.sub2api.adminCredentials.sourceRef;
  return {
    email: readSecret(config, { sourceRef, sourceKey: config.sub2api.adminCredentials.emailKey }),
    password: readSecret(config, { sourceRef, sourceKey: config.sub2api.adminCredentials.passwordKey }),
  };
}
