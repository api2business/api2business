import type { AppConfig } from "./config";
import type { OperationsStore } from "./operations-store";
import { BugTeamClient } from "./bugteam-client";

export interface BugTeamCostSample {
  sampledAt: string;
  product: string;
  status: "ok" | "empty" | "error";
  available: number | null;
  unitPriceCny: number | null;
  minimumUnitPriceCny: number | null;
  maximumUnitPriceCny: number | null;
  minimumRemainingSeconds: number | null;
  maximumRemainingSeconds: number | null;
  expectedCostCnyPerApiUsd: number | null;
  minimumExpectedCostCnyPerApiUsd: number | null;
  maximumExpectedCostCnyPerApiUsd: number | null;
  fillRateApiUsdPerHour: number | null;
  errorSummary: string | null;
}

function finiteNumber(value: unknown, field: string, minimum = 0): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) throw new Error(`BugTeam inventory field ${field} is invalid`);
  return number;
}

export function projectBugTeamCostSample(
  inventory: Record<string, unknown>,
  config: AppConfig["bugTeam"]["monitor"],
  sampledAt = new Date().toISOString(),
): BugTeamCostSample {
  const available = finiteNumber(inventory.available, "available");
  if (!Number.isInteger(available)) throw new Error("BugTeam inventory field available is invalid");
  if (available === 0) return {
    sampledAt, product: config.product, status: "empty", available,
    unitPriceCny: null, minimumUnitPriceCny: null, maximumUnitPriceCny: null,
    minimumRemainingSeconds: null, maximumRemainingSeconds: null,
    expectedCostCnyPerApiUsd: null, minimumExpectedCostCnyPerApiUsd: null,
    maximumExpectedCostCnyPerApiUsd: null, fillRateApiUsdPerHour: null, errorSummary: null,
  };
  const estimatedUnitPriceFen = finiteNumber(inventory.estimated_unit_price_fen, "estimated_unit_price_fen");
  const minimumRemainingSeconds = finiteNumber(inventory.minimum_remaining_seconds, "minimum_remaining_seconds", 1);
  const unitPriceCny = estimatedUnitPriceFen / 100;
  const expectedCostCnyPerApiUsd = unitPriceCny / config.expectedOutputApiUsd;
  return {
    sampledAt, product: config.product, status: "ok", available, unitPriceCny,
    minimumUnitPriceCny: unitPriceCny, maximumUnitPriceCny: unitPriceCny,
    minimumRemainingSeconds, maximumRemainingSeconds: minimumRemainingSeconds,
    expectedCostCnyPerApiUsd,
    minimumExpectedCostCnyPerApiUsd: expectedCostCnyPerApiUsd,
    maximumExpectedCostCnyPerApiUsd: expectedCostCnyPerApiUsd,
    fillRateApiUsdPerHour: config.expectedOutputApiUsd * 3600 / minimumRemainingSeconds,
    errorSummary: null,
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(cfk_[A-Za-z0-9_-]+|rt\.[A-Za-z0-9._-]+)/gu, "[redacted]")
    .slice(0, 500);
}

export class BugTeamCostMonitor {
  private client: BugTeamClient | null = null;

  constructor(private readonly config: AppConfig, private readonly store: OperationsStore) {}

  async sample(): Promise<BugTeamCostSample> {
    const sampledAt = new Date().toISOString();
    try {
      this.client ??= new BugTeamClient(this.config);
      const inventory = await this.client.inventory(this.config.bugTeam.monitor.product, 1);
      const available = finiteNumber(inventory.available, "available");
      if (!Number.isInteger(available)) throw new Error("BugTeam inventory field available is invalid");
      let sample = projectBugTeamCostSample(inventory, this.config.bugTeam.monitor, sampledAt);
      if (sample.status === "empty") {
        const previous = await this.store.getLatestSuccessfulBugTeamCostSample(sample.product);
        if (previous) sample = {
          ...sample,
          unitPriceCny: previous.unitPriceCny,
          minimumUnitPriceCny: previous.minimumUnitPriceCny,
          maximumUnitPriceCny: previous.maximumUnitPriceCny,
          minimumRemainingSeconds: previous.minimumRemainingSeconds,
          maximumRemainingSeconds: previous.maximumRemainingSeconds,
          expectedCostCnyPerApiUsd: previous.expectedCostCnyPerApiUsd,
          minimumExpectedCostCnyPerApiUsd: previous.minimumExpectedCostCnyPerApiUsd,
          maximumExpectedCostCnyPerApiUsd: previous.maximumExpectedCostCnyPerApiUsd,
          fillRateApiUsdPerHour: previous.fillRateApiUsdPerHour,
        };
      }
      await this.store.addBugTeamCostSample(sample);
      return sample;
    } catch (error) {
      const sample: BugTeamCostSample = {
        sampledAt, product: this.config.bugTeam.monitor.product, status: "error", available: null,
        unitPriceCny: null, minimumUnitPriceCny: null, maximumUnitPriceCny: null,
        minimumRemainingSeconds: null, maximumRemainingSeconds: null,
        expectedCostCnyPerApiUsd: null, minimumExpectedCostCnyPerApiUsd: null,
        maximumExpectedCostCnyPerApiUsd: null, fillRateApiUsdPerHour: null,
        errorSummary: safeError(error),
      };
      await this.store.addBugTeamCostSample(sample);
      throw error;
    }
  }
}
