import { expect, test } from "bun:test";
import {
  cooldownDiagnoseQuery,
  projectCooldownDiagnoseRow,
} from "./cooldown-diagnose-database";

test("cooldown diagnosis keeps the event query bounded and correlates request evidence", () => {
  expect(cooldownDiagnoseQuery).toContain("LIMIT $1");
  expect(cooldownDiagnoseQuery).toContain("l.created_at >= $2::timestamptz");
  expect(cooldownDiagnoseQuery).toContain("e.request_id = c.request_id");
  expect(cooldownDiagnoseQuery).toContain("upstream_failover_switching");
  expect(cooldownDiagnoseQuery).toContain("temp_unschedulable");
  expect(cooldownDiagnoseQuery).toContain("probe.id = l.api_key_id");
});

test("cooldown projection exposes evidence counters without raw reason payloads", () => {
  const projected = projectCooldownDiagnoseRow({
    sampled_event_rows: 4,
    cooldown_events: 4,
    affected_accounts: 2,
    no_request_id_events: 1,
    linked_error_events: 3,
    linked_upstream_events: 2,
    suspect_client_events: 1,
    followed_by_failover_events: 2,
    currently_active_events: 1,
    events: [{ eventId: 1, evidenceClass: "linked_upstream_error" }],
  });
  expect(projected.summary).toEqual({
    sampledEventRows: 4,
    cooldownEvents: 4,
    affectedAccounts: 2,
    noRequestIdEvents: 1,
    linkedErrorEvents: 3,
    temporalLinkedEvents: 0,
    linkedUpstreamEvents: 2,
    suspectClientEvents: 1,
    followedByFailoverEvents: 2,
    currentlyActiveEvents: 1,
  });
  expect(projected.events).toEqual([{ eventId: 1, evidenceClass: "linked_upstream_error" }]);
});
