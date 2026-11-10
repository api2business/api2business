import { describe, expect, test } from "bun:test";
import {
  projectProbeCacheAccount,
  summarizeProbeCacheEvidence,
  summarizeProbeCacheRecords,
} from "./idle-probe-cache-summary";

describe("idle probe cache summary", () => {
  test("keeps unknown separate from a verified miss and calculates the known-only hit rate", () => {
    const summary = summarizeProbeCacheEvidence([
      { accountId: 1, cacheHit: true, cacheReadTokens: 1500, inputTokens: 2048, cacheReadField: "input_tokens_details.cached_tokens" },
      { accountId: 2, cacheHit: false, cacheReadTokens: 0, inputTokens: 2048, cacheReadField: "input_tokens_details.cached_tokens" },
      { accountId: 3, cacheHit: null, cacheReadTokens: null, inputTokens: null },
    ]);

    expect(summary).toMatchObject({
      requestCount: 3,
      knownCount: 2,
      hitCount: 1,
      missCount: 1,
      unknownCount: 1,
      hitRate: 0.5,
      cacheReadTokens: 1500,
      cacheReadKnownCount: 2,
      rebilledInputTokens: 2596,
      rebilledKnownCount: 2,
    });
    expect(summary.accounts.map((account) => account.cacheState)).toEqual(["hit", "miss", "unknown"]);
  });

  test("does not treat an empty request list as zero misses", () => {
    expect(summarizeProbeCacheEvidence(undefined)).toMatchObject({
      requestCount: 0,
      knownCount: 0,
      missCount: 0,
      unknownCount: 0,
      hitRate: null,
      cacheReadTokens: null,
      rebilledInputTokens: null,
    });
  });

  test("counts requests without persisted evidence as unknown instead of missing or zero", () => {
    expect(summarizeProbeCacheEvidence(undefined, 4)).toMatchObject({
      requestCount: 4,
      knownCount: 0,
      hitCount: 0,
      missCount: 0,
      unknownCount: 4,
      hitRate: null,
      cacheReadTokens: null,
      rebilledInputTokens: null,
    });
  });

  test("adds only the evidence gap to a partially persisted round", () => {
    expect(summarizeProbeCacheEvidence([
      { cacheHit: true, cacheReadTokens: 1200, inputTokens: 1600 },
      { cacheHit: false, cacheReadTokens: 0, inputTokens: 1600 },
    ], 1)).toMatchObject({
      requestCount: 3,
      knownCount: 2,
      unknownCount: 1,
      hitRate: 0.5,
    });
  });

  test("supports provider fields where cached input is reported separately", () => {
    expect(projectProbeCacheAccount({
      cacheHit: true,
      cacheReadTokens: 1200,
      inputTokens: 300,
      cacheReadField: "cache_read_input_tokens",
    })).toMatchObject({
      cacheState: "hit",
      rebilledInputTokens: 300,
    });
  });

  test("keeps automatic and manual denominators independent", () => {
    const automaticEvidence = [
      { cacheHit: true, cacheReadTokens: 2000, inputTokens: 2500 },
      { cacheHit: false, cacheReadTokens: 0, inputTokens: 2500 },
      { cacheHit: null, cacheReadTokens: null },
    ];
    const manualEvidence = [{ cacheHit: true, cacheReadTokens: 1800, inputTokens: 2400 }];
    const records = [
      { triggerType: "automatic", requestEvidence: automaticEvidence, cache: summarizeProbeCacheEvidence(automaticEvidence) },
      { triggerType: "manual", requestEvidence: manualEvidence, cache: summarizeProbeCacheEvidence(manualEvidence) },
    ];

    const summary = summarizeProbeCacheRecords(records);
    expect(summary.automatic).toMatchObject({ knownCount: 2, hitCount: 1, missCount: 1, unknownCount: 1, hitRate: 0.5 });
    expect(summary.manual).toMatchObject({ knownCount: 1, hitCount: 1, missCount: 0, unknownCount: 0, hitRate: 1 });
  });
});
