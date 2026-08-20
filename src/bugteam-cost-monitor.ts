import type { AppConfig } from "./config";
import type { OperationsStore } from "./operations-store";
import { BugTeamClient } from "./bugteam-client";
import { selectLowestBugTeamShelf } from "./bugteam-pricing";

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

export function projectBugTeamCostSample(
  shelves: Record<string, unknown>,
  pricing: Record<string, unknown>,
  config: AppConfig["bugTeam"]["monitor"],
  sampledAt = new Date().toISOString(),
): BugTeamCostSample {
  const selected = selectLowestBugTeamShelf(shelves, pricing, 1);
  if (!selected) return {
    sampledAt, product: config.product, status: "empty", available: 0,
    unitPriceCny: null, minimumUnitPriceCny: null, maximumUnitPriceCny: null,
    minimumRemainingSeconds: null, maximumRemainingSeconds: null,
    expectedCostCnyPerApiUsd: null, minimumExpectedCostCnyPerApiUsd: null,
    maximumExpectedCostCnyPerApiUsd: null, fillRateApiUsdPerHour: null, errorSummary: null,
  };
  const unitPriceCny = selected.unitPriceFen / 100;
  const expectedCostCnyPerApiUsd = unitPriceCny / config.expectedOutputApiUsd;
  return {
    sampledAt, product: config.product, status: "ok", available: selected.available, unitPriceCny,
    minimumUnitPriceCny: unitPriceCny, maximumUnitPriceCny: unitPriceCny,
    minimumRemainingSeconds: selected.remainingSeconds, maximumRemainingSeconds: selected.remainingSeconds,
    expectedCostCnyPerApiUsd,
    minimumExpectedCostCnyPerApiUsd: expectedCostCnyPerApiUsd,
    maximumExpectedCostCnyPerApiUsd: expectedCostCnyPerApiUsd,
    fillRateApiUsdPerHour: config.expectedOutputApiUsd * 3600 / selected.remainingSeconds,
    errorSummary: null,
  };
}

export function repriceRetainedBugTeamCostSample(
  previous: BugTeamCostSample,
  config: AppConfig["bugTeam"]["monitor"],
): Pick<BugTeamCostSample,
  "expectedCostCnyPerApiUsd" | "minimumExpectedCostCnyPerApiUsd"
  | "maximumExpectedCostCnyPerApiUsd" | "fillRateApiUsdPerHour"> {
  const expectedCost = (unitPriceCny: number | null) => unitPriceCny == null
    ? null
    : unitPriceCny / config.expectedOutputApiUsd;
  const remainingSeconds = previous.minimumRemainingSeconds ?? previous.maximumRemainingSeconds;
  return {
    expectedCostCnyPerApiUsd: expectedCost(previous.unitPriceCny),
    minimumExpectedCostCnyPerApiUsd: expectedCost(previous.minimumUnitPriceCny),
    maximumExpectedCostCnyPerApiUsd: expectedCost(previous.maximumUnitPriceCny),
    fillRateApiUsdPerHour: remainingSeconds == null || remainingSeconds <= 0
      ? null
      : config.expectedOutputApiUsd * 3600 / remainingSeconds,
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
      const [shelves, pricing] = await Promise.all([
        this.client.inventoryShelves(this.config.bugTeam.monitor.product),
        this.client.inventory(this.config.bugTeam.monitor.product, 1),
      ]);
      let sample = projectBugTeamCostSample(shelves, pricing, this.config.bugTeam.monitor, sampledAt);
      if (sample.status === "empty") {
        const previous = await this.store.getLatestSuccessfulBugTeamCostSample(sample.product);
        if (previous) sample = {
          ...sample,
          unitPriceCny: previous.unitPriceCny,
          minimumUnitPriceCny: previous.minimumUnitPriceCny,
          maximumUnitPriceCny: previous.maximumUnitPriceCny,
          minimumRemainingSeconds: previous.minimumRemainingSeconds,
          maximumRemainingSeconds: previous.maximumRemainingSeconds,
          ...repriceRetainedBugTeamCostSample(previous, this.config.bugTeam.monitor),
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
