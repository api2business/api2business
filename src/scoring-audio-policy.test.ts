import { expect, test } from "bun:test";
import { isAudioRequest, audioRequestSql } from "./scoring-error-policy";
import { aggregateNativeGroupScore } from "./account-score-native";
import { defaultOpenAIOAuthModelMapping } from "./openai-oauth-import-policy";

test("audio policy recognizes model variants and endpoints without matching ordinary text models", () => {
  for (const model of ["gpt-4o-audio-preview", "GPT-4O-REALTIME-PREVIEW", "tts-1-hd", "whisper-1", "gpt-4o-mini-transcribe", "grok-voice-latest"]) expect(isAudioRequest([model])).toBe(true);
  for (const path of ["/v1/audio/speech", "/tts", "/v1/stt", "/v1/realtime?model=grok-4.5", "/custom-voices/id/audio", "/backend-api/codex/realtime/calls"]) expect(isAudioRequest(["gpt-6.1-sol"], path)).toBe(true);
  for (const model of ["gpt-6.1-sol", "gpt-image-2", "grok-4.7", "claude-sonnet-4-6", "audiovisual-text"]) expect(isAudioRequest([model], "/v1/responses")).toBe(false);
  expect(Object.keys(defaultOpenAIOAuthModelMapping()).some((model) => isAudioRequest([model]))).toBe(false);
  expect(audioRequestSql("u")).toContain("u.upstream_model");
});

test("historical audio errors and model-less switch events cannot lower text account quality", () => {
  const input = {
    group: { id: 2, name: "pool", platform: "openai", status: "active" },
    accounts: [{ id: 15, name: "primary", platform: "openai", status: "active" }],
    usage: [{ id: 1, request_id: "text-success", account_id: 15, group_id: 2, model: "gpt-6.1-sol", stream: true, input_tokens: 10, output_tokens: 5, actual_cost: .1, duration_ms: 1000, first_token_ms: 500, created_at: "2026-10-16T01:00:00Z" }],
    requestErrors: [{ id: 1, request_id: "text-fail", account_id: 15, status_code: 502, phase: "upstream", model: "gpt-6.1-sol" }],
    systemLogs: [], overview: {}, availability: { status: "available" as const, data: {}, reason: null }, concurrency: { status: "available" as const, data: {}, reason: null },
  };
  const before = aggregateNativeGroupScore(input);
  const after = aggregateNativeGroupScore({ ...input,
    usage: [...input.usage, { ...input.usage[0]!, id: 2, model: "gpt-4o-audio-preview", request_id: "audio-success", first_token_ms: 999999 }],
    requestErrors: [...input.requestErrors, { ...input.requestErrors[0]!, id: 2, request_id: "audio-fail", model: "gpt-4o-audio-preview" },
      { ...input.requestErrors[0]!, id: 3, request_id: "voice-path", model: "grok-4.5", inbound_endpoint: "/v1/tts" }],
    systemLogs: [{ id: 1, created_at: "2026-10-16T01:00:00Z", message: "openai.upstream_failover_switching", account_id: 15, request_id: "audio-fail", extra: { group_id: 2 } }],
  });
  expect(after.accounts).toEqual(before.accounts);
  expect(after.accounts[0]?.failureRequests).toBe(1);
});
