type Row = Record<string, unknown>;

/** OAuth accounts are managed separately and never enter score or priority workflows. */
export function isOAuthAccount(row: Row): boolean {
  const accountType = row.accountType ?? row.account_type ?? row.type;
  return String(accountType ?? "").trim().toLowerCase() === "oauth";
}
