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

function priceForRemaining(baseUnitPriceFen: number, billingBaseSeconds: number, remainingSeconds: number): number {
  return Math.round(baseUnitPriceFen * remainingSeconds / billingBaseSeconds) / 100;
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
  const baseUnitPriceFen = finiteNumber(inventory.base_unit_price_fen, "base_unit_price_fen", 1);
  const billingBaseSeconds = finiteNumber(inventory.billing_base_seconds, "billing_base_seconds", 1);
  const estimatedUnitPriceFen = finiteNumber(inventory.estimated_unit_price_fen, "estimated_unit_price_fen");
  const minimumRemainingSeconds = finiteNumber(inventory.minimum_remaining_seconds, "minimum_remaining_seconds", 1);
  const maximumRemainingSeconds = finiteNumber(inventory.maximum_remaining_seconds, "maximum_remaining_seconds", 1);
  const lowerSeconds = Math.min(minimumRemainingSeconds, maximumRemainingSeconds);
  const upperSeconds = Math.max(minimumRemainingSeconds, maximumRemainingSeconds);
  const unitPriceCny = estimatedUnitPriceFen / 100;
  const minimumUnitPriceCny = priceForRemaining(baseUnitPriceFen, billingBaseSeconds, lowerSeconds);
  const maximumUnitPriceCny = priceForRemaining(baseUnitPriceFen, billingBaseSeconds, upperSeconds);
  return {
    sampledAt, product: config.product, status: "ok", available, unitPriceCny,
    minimumUnitPriceCny, maximumUnitPriceCny,
    minimumRemainingSeconds: lowerSeconds, maximumRemainingSeconds: upperSeconds,
    expectedCostCnyPerApiUsd: unitPriceCny / config.expectedOutputApiUsd,
    minimumExpectedCostCnyPerApiUsd: minimumUnitPriceCny / config.expectedOutputApiUsd,
    maximumExpectedCostCnyPerApiUsd: maximumUnitPriceCny / config.expectedOutputApiUsd,
    fillRateApiUsdPerHour: config.expectedOutputApiUsd * 3600 / lowerSeconds,
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
      const first = await this.client.inventory(this.config.bugTeam.monitor.product, 1);
      const available = finiteNumber(first.available, "available");
      if (!Number.isInteger(available)) throw new Error("BugTeam inventory field available is invalid");
      const inventory = available > 1
        ? await this.client.inventory(this.config.bugTeam.monitor.product, available)
        : first;
      const sample = projectBugTeamCostSample(inventory, this.config.bugTeam.monitor, sampledAt);
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
