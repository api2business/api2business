import { expect, test } from "bun:test";
import {
  errorDiagnoseQuery,
  projectErrorDiagnoseRow,
} from "./error-diagnose-database";

test("error diagnosis uses one bounded query for signatures and failover chains", () => {
  expect(errorDiagnoseQuery).toContain("LIMIT $1");
  expect(errorDiagnoseQuery).toContain("u.request_id = e.request_id");
  expect(errorDiagnoseQuery).toContain("GROUP BY request_key");
  expect(errorDiagnoseQuery).toContain("COUNT(DISTINCT account_id)");
  expect(errorDiagnoseQuery).toContain("rank <= $4");
  expect(errorDiagnoseQuery).toContain("rank <= $5");
  expect(errorDiagnoseQuery).toContain("a.name = $2::text");
  expect(errorDiagnoseQuery).toContain("g.name = $3::text");
  expect(errorDiagnoseQuery).not.toContain("api_key_prefix");
});

test("error diagnosis projection exposes bounded facts without raw payloads", () => {
  const projected = projectErrorDiagnoseRow({
    sampled_error_rows: 5,
    distinct_requests: 3,
    customer_visible_requests: 2,
    recovered_requests: 1,
    failover_triggered_requests: 2,
    failover_recovered_requests: 1,
    failover_failed_requests: 1,
    failover_aborted_requests: 1,
    signatures: [{
      signature: "502:upstream:upstream_error:-:upstream_overloaded",
      stablePhrase: "upstream_overloaded",
      requests: 2,
    }],
    chains: [{ requestId: "request-1", attempts: [{ accountId: 1 }] }],
  });
  expect(projected.summary).toEqual({
    sampledErrorRows: 5,
    distinctRequests: 3,
    customerVisibleRequests: 2,
    recoveredRequests: 1,
    failoverTriggeredRequests: 2,
    failoverRecoveredRequests: 1,
    failoverFailedRequests: 1,
    failoverAbortedRequests: 1,
  });
  expect(projected.analysisHints).toEqual({
    failoverWithoutRecovery: 1,
    unclassifiedSignatures: 0,
  });
  expect(JSON.stringify(projected)).not.toContain("errorBody");
  expect(JSON.stringify(projected)).not.toContain("errorMessage");
});
