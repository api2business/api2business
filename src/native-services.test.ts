import { expect, test } from "bun:test";
import { loadConfig } from "./config";
import { COMPOSE_READ_TIMEOUT_MS, COMPOSE_UP_TIMEOUT_MS, nativeComponentRequiresTemporalAddress } from "./native-services";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("native compose builds get a bounded build window without extending read commands", () => {
  expect(COMPOSE_UP_TIMEOUT_MS).toBe(600_000);
  expect(COMPOSE_READ_TIMEOUT_MS).toBe(120_000);
});

test("native services resolve Temporal whenever a component declares the address", () => {
  const config = loadConfig("config/api2business.example.yaml");

  expect(config.monitor.automaticRefresh.enabled).toBeTrue();
  expect(nativeComponentRequiresTemporalAddress(config, "api")).toBeTrue();
  expect(nativeComponentRequiresTemporalAddress(config, "worker")).toBeTrue();
  expect(nativeComponentRequiresTemporalAddress(config, "web")).toBeFalse();
});

test("native API and worker keep resolving Temporal when automation is disabled", () => {
  const config = structuredClone(loadConfig("config/api2business.example.yaml"));
  config.monitor.automaticRefresh.enabled = false;

  expect(nativeComponentRequiresTemporalAddress(config, "api")).toBeTrue();
  expect(nativeComponentRequiresTemporalAddress(config, "worker")).toBeTrue();
  expect(nativeComponentRequiresTemporalAddress(config, "web")).toBeFalse();
});

test("native state root is pinned instead of falling back to the Compose default", () => {
  const example = readFileSync("config/api2business.example.yaml", "utf8");
  const withoutStateRoot = join("config", ".state-root-default.test.yaml");
  writeFileSync(withoutStateRoot, example.replace(/^\s*stateRoot:.*\n/mu, ""), "utf8");

  try {
    expect(loadConfig("config/api2business.example.yaml").runtime.stateRoot).toBe("/var/lib/api2business");
    expect(loadConfig(withoutStateRoot).runtime.stateRoot).toBe("/var/lib/api2business");
  } finally {
    unlinkSync(withoutStateRoot);
  }
});
