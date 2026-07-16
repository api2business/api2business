import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config";

export interface WebAuthSecrets {
  password: string;
  apiKey: string;
  sessionSecret: string;
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function cookies(request: Request): Map<string, string> {
  return new Map((request.headers.get("cookie") ?? "").split(";").map((item) => {
    const index = item.indexOf("=");
    return index < 0 ? [item.trim(), ""] : [item.slice(0, index).trim(), item.slice(index + 1).trim()];
  }));
}

export function apiKeyAuthorized(request: Request, secrets: WebAuthSecrets): boolean {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") && equal(value.slice(7), secrets.apiKey);
}

export function sessionAuthorized(request: Request, config: AppConfig, secrets: WebAuthSecrets): boolean {
  const token = cookies(request).get(config.webAuth.cookieName);
  if (!token) return false;
  const [payload, mac] = token.split(".", 2);
  if (!payload || !mac || !equal(signature(payload, secrets.sessionSecret), mac)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { user?: unknown; exp?: unknown };
    return parsed.user === config.webAuth.username && typeof parsed.exp === "number" && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

export function createSessionCookie(config: AppConfig, secrets: WebAuthSecrets): string {
  const payload = Buffer.from(JSON.stringify({
    user: config.webAuth.username,
    exp: Date.now() + config.webAuth.sessionTtlSeconds * 1000,
  })).toString("base64url");
  const value = `${payload}.${signature(payload, secrets.sessionSecret)}`;
  return `${config.webAuth.cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${config.webAuth.sessionTtlSeconds}`;
}

export function clearSessionCookie(config: AppConfig): string {
  return `${config.webAuth.cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function validLogin(username: unknown, password: unknown, config: AppConfig, secrets: WebAuthSecrets): boolean {
  return typeof username === "string" && typeof password === "string"
    && equal(username, config.webAuth.username) && equal(password, secrets.password);
}
