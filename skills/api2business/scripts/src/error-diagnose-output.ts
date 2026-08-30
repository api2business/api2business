type Row = Record<string, unknown>;

function responseEvidence(attempt: Row): Row {
  const sources = [
    ["upstreamErrorDetail", attempt.upstreamErrorDetail],
    ["systemLogText", attempt.systemLogText],
    ["upstreamErrorMessage", attempt.upstreamErrorMessage],
    ["errorBody", attempt.errorBody],
    ["errorMessage", attempt.errorMessage],
  ] as const;
  const source = sources.find(([, value]) => String(value ?? "").trim());
  const raw = source ? String(source[1]).trim() : "";
  const summary = raw
    ? raw
      .replace(/bearer\s+[A-Za-z0-9._~+\/-]+/giu, "Bearer [redacted]")
      .replace(/(api[_ -]?key|authorization|token|secret|password)\s*[:=]\s*[^,\s}]+/giu, "$1=[redacted]")
      .slice(0, 512)
    : null;
  return {
    available: summary !== null,
    source: source?.[0] ?? null,
    length: raw.length,
    summary,
    truncated: raw.length > 512,
  };
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => typeof item === "object" && item !== null)
    : [];
}

function classifyChain(chain: Row): Row {
  const attempts = rows(chain.attempts).map((attempt) => {
    const projected = { ...attempt, responseEvidence: responseEvidence(attempt) };
    delete projected.errorMessage;
    delete projected.errorBody;
    delete projected.upstreamErrorMessage;
    delete projected.upstreamErrorDetail;
    delete projected.systemLogText;
    return projected;
  });
  const failoverAttempts = attempts.filter((attempt) =>
    attempt.errorType === "failover_event"
    || String(attempt.signature ?? "").includes(":failover_event:"),
  );
  const templateCandidates = attempts.filter((attempt) => attempt.errorType !== "failover_event");
  const templateMatched = failoverAttempts.length > 0;
  const statusMismatches = attempts.filter((attempt) =>
    attempt.recordedStatusCode != null
    && attempt.upstreamStatusCode != null
    && Number(attempt.recordedStatusCode) !== Number(attempt.upstreamStatusCode),
  );
  const failoverExhausted = templateMatched && chain.recovered !== true && (
    Number(chain.attemptCount ?? 0) > 1 || failoverAttempts.length > 0
  );
  const classification = templateMatched
    ? (failoverExhausted ? "template_matched_failover_exhausted" : "template_matched")
    : (statusMismatches.length > 0 ? "template_not_matched_status_code_mismatch" : "template_not_matched");
  return {
    attempts,
    diagnosis: {
      templateMatched,
      failoverExhausted,
      classification,
      templateAttemptCount: templateCandidates.length,
      failoverSwitchCount: failoverAttempts.length,
      statusMismatchCount: statusMismatches.length,
      statusMismatch: statusMismatches.length > 0,
    },
  };
}

function decorateDiagnosis(value: Row): Row {
  const chains = rows(value.chains).map((chain) => {
    const result = classifyChain(chain);
    return { ...chain, attempts: result.attempts, diagnosis: result.diagnosis };
  });
  return { ...value, chains };
}

export function emitErrorDiagnosis(value: Row, json: boolean): void {
  const output = decorateDiagnosis(value);
  const chains = rows(output.chains);
  if (json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  const summary = typeof value.summary === "object" && value.summary !== null
    ? value.summary as Row
    : {};
  console.log(
    `API2BUSINESS ERROR DIAGNOSIS rows=${String(summary.sampledErrorRows ?? 0)}`
    + ` requests=${String(summary.distinctRequests ?? 0)}`
    + ` visible=${String(summary.customerVisibleRequests ?? 0)}`
    + ` recovered=${String(summary.recoveredRequests ?? 0)}`
    + ` failover=${String(summary.failoverTriggeredRequests ?? 0)}`
    + ` failoverRecovered=${String(summary.failoverRecoveredRequests ?? 0)}`
    + ` failoverFailed=${String(summary.failoverFailedRequests ?? 0)}`
    + ` databaseQueries=${String(value.databaseQueries ?? 0)}`,
  );
  console.log("VISIBLE  REQUESTS  RECOVERED  ACCOUNTS  SIGNATURE");
  for (const row of rows(value.signatures)) {
    console.log([
      String(row.customerVisible ?? 0).padStart(7),
      String(row.requests ?? 0).padStart(8),
      String(row.recovered ?? 0).padStart(9),
      String(row.accounts ?? 0).padStart(8),
      String(row.signature ?? "-"),
    ].join("  "));
  }
  if (chains.length === 0) return;
  console.log("\nCUSTOMER-VISIBLE / FAILOVER SAMPLES");
  console.log("VISIBLE  RECOVERED  FAILOVER  ATTEMPTS  STATUS  REQUEST_ID  FINAL_SIGNATURE");
  for (const row of chains) {
    console.log([
      (row.customerVisible === true ? "yes" : "no").padEnd(7),
      (row.recovered === true ? "yes" : "no").padEnd(9),
      (row.failoverTriggered === true ? "yes" : "no").padEnd(8),
      String(row.attemptCount ?? 0).padStart(8),
      String(row.finalStatusCode ?? "-").padStart(6),
      String(row.requestId ?? "-").padEnd(36),
      String(row.finalSignature ?? "-"),
    ].join("  "));
  }
}

export function emitErrorInspection(value: Row, json: boolean): void {
  const diagnosis = decorateDiagnosis((value.diagnosis as Row | undefined) ?? {});
  const output = { ...value, diagnosis };
  if (json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  const detail = value.detail as Row | undefined;
  const attempts = rows(detail?.attempts);
  console.log(
      `API2BUSINESS ERROR INSPECT request=${String(output.requestId ?? "-")}`
      + ` template=${String((rows(diagnosis.chains)[0]?.diagnosis as Row | undefined)?.classification ?? "-")}`
      + ` attempts=${attempts.length}`,
  );
  console.log("ACCOUNT  RECORDED  UPSTREAM  EVIDENCE");
  for (const attempt of attempts) {
    const evidence = attempt.responseEvidence as Row | undefined;
    console.log([
      String(attempt.accountId ?? "-").padStart(7),
      String(attempt.recordedStatusCode ?? "-").padStart(8),
      String(attempt.upstreamStatusCode ?? "-").padStart(8),
      evidence?.available === true ? `${String(evidence.source)}:${String(evidence.summary)}` : "unavailable",
    ].join("  "));
  }
}
