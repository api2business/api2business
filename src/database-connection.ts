const recoverableConnectionPatterns = [
  /connection (?:is )?closed/iu,
  /connection terminated/iu,
  /connection reset/iu,
  /server closed the connection unexpectedly/iu,
  /socket[^\n]*closed/iu,
  /broken pipe/iu,
  /econnreset/iu,
  /econnrefused/iu,
  /^Failed to read data$/iu,
];

export function databaseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecoverableDatabaseConnectionError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (["ERR_POSTGRES_INVALID_MESSAGE", "ERR_POSTGRES_INVALID_MESSAGE_LENGTH", "ERR_POSTGRES_UNEXPECTED_MESSAGE"].includes(code)) return true;
  const message = databaseErrorMessage(error);
  return recoverableConnectionPatterns.some((pattern) => pattern.test(message));
}
