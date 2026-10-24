// Link gateway IDs to client usage IDs only through recorded native evidence.
export function usageRequestMatchesSql(usageId: string, gatewayId: string): string {
  return `(${usageId} = ${gatewayId} OR ${usageId} IN (
    SELECT 'client:' || NULLIF(identity_log.extra->>'client_request_id','')
    FROM ops_system_logs identity_log WHERE identity_log.request_id=${gatewayId}
  ))`;
}

// Native request-final policy events override usage, including linked client IDs.
export function terminalPolicyExistsSql(requestId: string, source = "ops_error_logs"): string {
  return `EXISTS (SELECT 1 FROM ${source} terminal
      WHERE ${usageRequestMatchesSql(requestId, "terminal.request_id")}
        AND terminal.error_phase='request' AND terminal.error_type='cyber_policy')`;
}
