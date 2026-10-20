import { expect,test } from "bun:test";
import { sourceCoverageFacts,sourceCoverageSql } from "./observability-source-coverage";

test("source warnings do not invent terminal or latency samples",()=>{
  expect(sourceCoverageFacts({unrepresentedRequests:0,suppressedWarningRecords:0}).complete).toBeTrue();
  expect(sourceCoverageFacts({unrepresentedRequests:2,suppressedWarningRecords:0}).complete).toBeFalse();
  expect(sourceCoverageFacts({unrepresentedRequests:0,suppressedWarningRecords:1}).complete).toBeFalse();
  expect(sourceCoverageFacts(null).complete).toBeFalse();
  expect(sourceCoverageFacts({}).complete).toBeFalse();
});

test("source read keeps exact window, dedup, probe and audio boundaries without leaking extra",()=>{
  expect(sourceCoverageSql).toContain("l.message='openai_usage.success_missing_usage'");
  expect(sourceCoverageSql).toContain("l.created_at >= $1::timestamptz AND l.created_at < $2::timestamptz");
  expect(sourceCoverageSql).toContain("u.request_id=s.request_id");
  expect(sourceCoverageSql).toContain("SELECT DISTINCT ON");
  expect(sourceCoverageSql).toContain("WHERE NOT probe AND NOT");
  expect(sourceCoverageSql).toContain("modelBreakdown");
  expect(sourceCoverageSql).toContain('pr."clientRequestId"=l.client_request_id');
  expect(sourceCoverageSql).toContain('pr."accountId"=l.account_id');
  expect(sourceCoverageSql).toContain('pr."requestId"=l.request_id');
  expect(sourceCoverageSql).toContain('l.created_at >= pr."startedAt"');
  expect(sourceCoverageSql).not.toContain("l.extra,");
  expect(sourceCoverageSql).not.toContain("credentials");
});
