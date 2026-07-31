import { expect, test } from "bun:test";
import { loadConfig } from "./config";
import { nativeComponentRequiresTemporalAddress } from "./native-services";

test("native services resolve Temporal whenever a component declares the address", () => {
  const config = loadConfig("config/sub2rank.yaml");

  expect(config.monitor.automaticRefresh.enabled).toBeFalse();
  expect(nativeComponentRequiresTemporalAddress(config, "api")).toBeTrue();
  expect(nativeComponentRequiresTemporalAddress(config, "worker")).toBeTrue();
  expect(nativeComponentRequiresTemporalAddress(config, "web")).toBeFalse();
});

test("native API and worker keep resolving Temporal when automation is enabled", () => {
  const config = structuredClone(loadConfig("config/sub2rank.yaml"));
  config.monitor.automaticRefresh.enabled = true;

  expect(nativeComponentRequiresTemporalAddress(config, "api")).toBeTrue();
  expect(nativeComponentRequiresTemporalAddress(config, "worker")).toBeTrue();
  expect(nativeComponentRequiresTemporalAddress(config, "web")).toBeFalse();
});
