// Sub2API's native request-final policy event is not a recoverable upstream attempt.
export function terminalPolicyExistsSql(requestId: string, source = "ops_error_logs"): string {
  return `EXISTS (SELECT 1 FROM ${source} terminal
      WHERE terminal.request_id=${requestId}
        AND terminal.error_phase='request' AND terminal.error_type='cyber_policy')`;
}
