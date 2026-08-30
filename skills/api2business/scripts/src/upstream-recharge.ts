import type { AdminHttpClient } from "../../../../src/admin-http-client";
import { normalizeUpstreamWallet } from "../../../../src/upstream-valuation";

type Row = Record<string, unknown>;

export type RechargeVerificationStatus =
  | "pending"
  | "verified"
  | "snapshot_mismatch"
  | "missing_anchor"
  | "unavailable"
  | "workflow_failed";

const MAX_WALLET_PAGES = 1000;
const MAX_OUTPUT_IDS = 100;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "terminated", "timed_out"]);

export interface WalletAccountSnapshot {
  id: number;
  name: string;
  baseUrl: string;
  type: string;
  status: string;
  schedulable: boolean;
  rechargeCny: number | null;
  rechargeCount: number | null;
}

export interface WalletSnapshot {
  baseUrl: string;
  accounts: WalletAccountSnapshot[];
  accountIds: number[];
  advertisedPages: number;
  pagesRead: number;
  truncated: boolean;
}

export interface RechargeVerificationOptions {
  workflowId: string;
  expected?: {
    baseUrl?: string;
    amountCny?: number;
    operationId?: string;
    anchorAccountId?: number;
    walletAccountIds?: number[];
  };
}

function object(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
}

function text(value: unknown, limit = 500): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().slice(0, limit);
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function accountType(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replaceAll("_", "").replaceAll("-", "");
}

function accountSnapshot(row: Row, baseUrl: string): WalletAccountSnapshot | null {
  const id = positiveInteger(row.id);
  if (id === null || accountType(row.type) !== "apikey") return null;
  const rowBaseUrl = normalizeUpstreamWallet(row.baseUrl);
  if (rowBaseUrl !== baseUrl) return null;
  const rechargeCount = finiteNumber(row.rechargeCount);
  return {
    id,
    name: text(row.name, 160) ?? `#${id}`,
    baseUrl: rowBaseUrl,
    type: String(row.type ?? ""),
    status: String(row.status ?? ""),
    schedulable: row.schedulable === true,
    rechargeCny: finiteNumber(row.rechargeCny),
    rechargeCount: rechargeCount !== null && Number.isSafeInteger(rechargeCount) ? rechargeCount : null,
  };
}

function uniqueSortedIds(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(positiveInteger).filter((value): value is number => value !== null))].sort((left, right) => left - right);
}

function boundedIds(ids: number[]): Record<string, unknown> {
  return {
    count: ids.length,
    ids: ids.slice(0, MAX_OUTPUT_IDS),
    truncated: ids.length > MAX_OUTPUT_IDS,
  };
}

function sameIds(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function workflowSummary(workflow: Row, workflowId: string): Record<string, unknown> {
  const state = text(workflow.state, 80)?.toLowerCase() ?? "unknown";
  return {
    workflowId: text(workflow.workflowId, 240) ?? workflowId,
    runId: text(workflow.runId, 240),
    state,
    terminal: workflow.terminal === true || TERMINAL_STATES.has(state),
    error: text(workflow.error),
  };
}

function nextStatusCommand(workflowId: string): string {
  return `upstreams recharge-status --id ${workflowId} --over-api`;
}

export function normalizeRechargeWallet(value: string): string {
  const wallet = normalizeUpstreamWallet(value);
  if (!wallet) throw new Error("upstreams recharge requires a non-empty --base-url");
  return wallet;
}

export function validateRechargeIdempotencyKey(value: string): string {
  if (!value || value !== value.trim() || value.length > 160 || /[\r\n]/u.test(value)) {
    throw new Error("--idempotency-key must be non-empty, at most 160 characters, contain no newlines, and have no surrounding whitespace");
  }
  return value;
}

export async function readRechargeWalletSnapshot(
  client: Pick<AdminHttpClient, "upstreams">,
  baseUrl: string,
): Promise<WalletSnapshot> {
  const wallet = normalizeRechargeWallet(baseUrl);
  const firstListing = await client.upstreams(1, wallet);
  const advertisedPagesValue = Number(firstListing.totalPages);
  const advertisedPages = Number.isSafeInteger(advertisedPagesValue) && advertisedPagesValue > 0
    ? advertisedPagesValue
    : 1;
  const pagesToRead = Math.min(advertisedPages, MAX_WALLET_PAGES);
  const listings: Record<string, unknown>[] = [firstListing];
  for (let page = 2; page <= pagesToRead; page += 1) listings.push(await client.upstreams(page, wallet));

  const accountsById = new Map<number, WalletAccountSnapshot>();
  for (const listing of listings) {
    const rows = Array.isArray(listing.accounts) ? listing.accounts : [];
    for (const row of rows) {
      const snapshot = object(row) === null ? null : accountSnapshot(row as Row, wallet);
      if (snapshot) accountsById.set(snapshot.id, snapshot);
    }
  }
  const accounts = [...accountsById.values()].sort((left, right) => left.id - right.id);
  return {
    baseUrl: wallet,
    accounts,
    accountIds: accounts.map((account) => account.id),
    advertisedPages,
    pagesRead: listings.length,
    truncated: advertisedPages > MAX_WALLET_PAGES,
  };
}

function unavailable(
  workflow: Record<string, unknown>,
  workflowId: string,
  reason: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: false,
    verificationStatus: "unavailable" satisfies RechargeVerificationStatus,
    workflow: workflowSummary(workflow, workflowId),
    reason,
    ...details,
    next: nextStatusCommand(workflowId),
  };
}

export async function verifyRechargeWorkflow(
  client: Pick<AdminHttpClient, "workflowStatus" | "upstreams">,
  options: RechargeVerificationOptions,
): Promise<Record<string, unknown>> {
  const workflow = await client.workflowStatus(options.workflowId);
  const summary = workflowSummary(workflow, options.workflowId);
  const state = String(summary.state);
  const terminal = summary.terminal === true;
  if (!terminal) {
    return {
      ok: true,
      verificationStatus: "pending" satisfies RechargeVerificationStatus,
      workflow: summary,
      next: nextStatusCommand(options.workflowId),
    };
  }
  if (state !== "completed") {
    return {
      ok: false,
      verificationStatus: "workflow_failed" satisfies RechargeVerificationStatus,
      workflow: summary,
      next: null,
    };
  }

  const result = object(workflow.result);
  const workflowAccount = object(result?.account);
  const accounting = object(result?.accounting);
  if (!result || !workflowAccount || !accounting) {
    return unavailable(workflow, options.workflowId, "completed workflow result is missing account or accounting evidence");
  }

  const workflowAccountId = positiveInteger(workflowAccount.id);
  const accountingAccountId = positiveInteger(accounting.accountId);
  const amountCny = finiteNumber(accounting.amountCny);
  const operationId = text(accounting.operationId, 160);
  const entryId = text(accounting.entryId, 240);
  const mutation = typeof accounting.mutation === "boolean" ? accounting.mutation : null;
  const workflowBaseUrl = normalizeUpstreamWallet(String(workflowAccount.baseUrl ?? ""));
  const workflowWalletIds = uniqueSortedIds(result.walletAccountIds);
  const workflowRechargeCny = finiteNumber(workflowAccount.rechargeCny);
  const workflowRechargeCount = finiteNumber(workflowAccount.rechargeCount);
  const workflowStatus = text(workflowAccount.status, 80);
  const workflowSchedulable = typeof workflowAccount.schedulable === "boolean" ? workflowAccount.schedulable : null;

  const missingFields = [
    workflowAccountId === null ? "account.id" : null,
    accountingAccountId === null ? "accounting.accountId" : null,
    amountCny === null ? "accounting.amountCny" : null,
    operationId === null ? "accounting.operationId" : null,
    entryId === null ? "accounting.entryId" : null,
    mutation === null ? "accounting.mutation" : null,
    workflowBaseUrl ? null : "account.baseUrl",
    workflowWalletIds.length === 0 ? "walletAccountIds" : null,
    workflowRechargeCny === null ? "account.rechargeCny" : null,
    workflowRechargeCount === null || !Number.isSafeInteger(workflowRechargeCount) ? "account.rechargeCount" : null,
    workflowStatus ? null : "account.status",
    workflowSchedulable === null ? "account.schedulable" : null,
  ].filter((field): field is string => field !== null);
  if (missingFields.length > 0) {
    return unavailable(workflow, options.workflowId, "completed workflow result is incomplete", { missingFields });
  }

  const expected = options.expected ?? {};
  const expectedBaseUrl = expected.baseUrl ? normalizeRechargeWallet(expected.baseUrl) : workflowBaseUrl;
  const expectedAmountCny = expected.amountCny ?? amountCny;
  const expectedOperationId = expected.operationId ?? operationId;
  const expectedAnchorAccountId = expected.anchorAccountId ?? accountingAccountId ?? workflowAccountId;
  const snapshot = await readRechargeWalletSnapshot(client, workflowBaseUrl);
  if (snapshot.truncated) {
    return unavailable(workflow, options.workflowId, "wallet snapshot pagination exceeded the safety bound", {
      wallet: { baseUrl: snapshot.baseUrl, advertisedPages: snapshot.advertisedPages, pagesRead: snapshot.pagesRead },
    });
  }
  const currentAccount = snapshot.accounts.find((account) => account.id === expectedAnchorAccountId) ?? null;
  if (!currentAccount) {
    return {
      ok: false,
      verificationStatus: "missing_anchor" satisfies RechargeVerificationStatus,
      workflow: summary,
      accounting: { mutation, entryId, operationId, amountCny, accountId: accountingAccountId },
      wallet: { baseUrl: snapshot.baseUrl, workflowAccountIds: boundedIds(workflowWalletIds), currentAccountIds: boundedIds(snapshot.accountIds) },
      anchorAccountId: expectedAnchorAccountId,
      next: nextStatusCommand(options.workflowId),
    };
  }

  const checks = [
    { name: "accounting.operationId", ok: operationId === expectedOperationId, expected: expectedOperationId, actual: operationId },
    { name: "accounting.entryId", ok: entryId.length > 0, expected: "non-empty", actual: entryId },
    { name: "accounting.amountCny", ok: amountCny === expectedAmountCny, expected: expectedAmountCny, actual: amountCny },
    { name: "accounting.accountId", ok: accountingAccountId === expectedAnchorAccountId, expected: expectedAnchorAccountId, actual: accountingAccountId },
    { name: "account.baseUrl", ok: workflowBaseUrl === expectedBaseUrl, expected: expectedBaseUrl, actual: workflowBaseUrl },
    { name: "account.id", ok: workflowAccountId === expectedAnchorAccountId, expected: expectedAnchorAccountId, actual: workflowAccountId },
    { name: "account.rechargeCny", ok: currentAccount.rechargeCny === workflowRechargeCny, expected: workflowRechargeCny, actual: currentAccount.rechargeCny },
    { name: "account.rechargeCount", ok: currentAccount.rechargeCount === workflowRechargeCount, expected: workflowRechargeCount, actual: currentAccount.rechargeCount },
    { name: "account.status", ok: currentAccount.status === workflowStatus, expected: workflowStatus, actual: currentAccount.status },
    { name: "account.schedulable", ok: currentAccount.schedulable === workflowSchedulable, expected: workflowSchedulable, actual: currentAccount.schedulable },
    { name: "account.status-healthy", ok: currentAccount.status === "active", expected: "active", actual: currentAccount.status },
    { name: "account.schedulable-healthy", ok: currentAccount.schedulable === true, expected: true, actual: currentAccount.schedulable },
    { name: "wallet.accountIds", ok: sameIds(workflowWalletIds, snapshot.accountIds), expected: boundedIds(workflowWalletIds), actual: boundedIds(snapshot.accountIds) },
  ];
  const verified = checks.every((check) => check.ok);
  return {
    ok: verified,
    verificationStatus: (verified ? "verified" : "snapshot_mismatch") satisfies RechargeVerificationStatus,
    workflow: summary,
    accounting: { mutation, entryId, operationId, amountCny, accountId: accountingAccountId },
    anchor: {
      accountId: expectedAnchorAccountId,
      workflow: {
        id: workflowAccountId,
        rechargeCny: workflowRechargeCny,
        rechargeCount: workflowRechargeCount,
        status: workflowStatus,
        schedulable: workflowSchedulable,
      },
      current: currentAccount,
    },
    wallet: {
      baseUrl: snapshot.baseUrl,
      workflowAccountIds: boundedIds(workflowWalletIds),
      currentAccountIds: boundedIds(snapshot.accountIds),
      submittedAccountIds: expected.walletAccountIds ? boundedIds(uniqueSortedIds(expected.walletAccountIds)) : null,
    },
    checks,
    next: verified ? null : nextStatusCommand(options.workflowId),
  };
}
