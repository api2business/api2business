import { expect, test } from "bun:test";
import { loadConfig } from "./config";
import { nativeComponentRequiresTemporalAddress } from "./native-services";

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
