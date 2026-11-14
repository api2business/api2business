import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { createSessionCookie } from "./web-auth";

test("HTTPS session cookies carry Secure, HttpOnly and SameSite=Strict", () => {
  const config = { webAuth: { username: "synthetic-security-test", sessionTtlSeconds: 60, cookieName: "synthetic_session" } } as any;
  const cookie = createSessionCookie(config, { password: "synthetic", apiKey: "synthetic", sessionSecret: "synthetic-only" }, true);
  expect(cookie).toContain("; Secure;");
  expect(cookie).toContain("; HttpOnly;");
  expect(cookie).toContain("; SameSite=Strict;");
});

test("compose web does not override the loopback Vite listener", () => {
  const compose = parse(readFileSync(new URL("../compose.yaml", import.meta.url), "utf8"));
  const command = compose.services.web.command as string[];
  expect(command).toEqual(["bunx", "vite", "--config", "vite.config.ts"]);
  expect(command).not.toContain("0.0.0.0");
});

test("example compose target uses Secure cookies", () => {
  const config = parse(readFileSync(new URL("../config/api2business.example.yaml", import.meta.url), "utf8"));
  expect(config.runtime.serverTargets.compose.secureCookies).toBeTrue();
  expect(config.runtime.serverTargets.compose.webListenHost).toBe("127.0.0.1");
});
