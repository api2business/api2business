const recoverableConnectionPatterns = [
  /connection (?:is )?closed/iu,
  /connection terminated/iu,
  /connection reset/iu,
  /server closed the connection unexpectedly/iu,
  /socket[^\n]*closed/iu,
  /broken pipe/iu,
  /econnreset/iu,
  /econnrefused/iu,
];

export function databaseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecoverableDatabaseConnectionError(error: unknown): boolean {
  const message = databaseErrorMessage(error);
  return recoverableConnectionPatterns.some((pattern) => pattern.test(message));
}
