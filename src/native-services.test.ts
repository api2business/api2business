import { expect, test } from "bun:test";
import { loadConfig } from "./config";
import { nativeComponentRequiresTemporalAddress } from "./native-services";

test("native priority automation does not resolve Temporal when score refresh is disabled", () => {
  const config = loadConfig("config/sub2rank.yaml");

  expect(config.monitor.automaticRefresh.enabled).toBeFalse();
  expect(nativeComponentRequiresTemporalAddress(config, "api")).toBeFalse();
  expect(nativeComponentRequiresTemporalAddress(config, "worker")).toBeFalse();
  expect(nativeComponentRequiresTemporalAddress(config, "web")).toBeFalse();
});

test("native API and worker resolve Temporal only when score refresh is enabled", () => {
  const config = structuredClone(loadConfig("config/sub2rank.yaml"));
  config.monitor.automaticRefresh.enabled = true;

  expect(nativeComponentRequiresTemporalAddress(config, "api")).toBeTrue();
  expect(nativeComponentRequiresTemporalAddress(config, "worker")).toBeTrue();
  expect(nativeComponentRequiresTemporalAddress(config, "web")).toBeFalse();
});
