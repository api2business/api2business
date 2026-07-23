import { mergeAccountScores } from "./account-score-aggregation";
import { aggregateNativeGroupScore } from "./account-score-native";
import type { Sub2ApiAccount, Sub2ApiGroup, Sub2ApiRequestError, Sub2ApiUsageRow } from "./sub2api-client";
import { Sub2ApiClient } from "./sub2api-client";

type Row = Record<string, unknown>;

interface AccountMembership {
  account: Sub2ApiAccount;
  groups: Sub2ApiGroup[];
}

function timestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function record(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function currentState(availability: { status: "available" | "unavailable"; data: Row; reason: string | null }, account: Sub2ApiAccount): Row {
  const values = Object.values(record(availability.data.account)).map(record);
  const native = values.find((value) => Number(value.account_id) === account.id);
  return {
    currentAvailable: typeof native?.is_available === "boolean" ? native.is_available : null,
    currentStatus: typeof native?.status === "string" ? native.status : account.status,
    currentError: typeof native?.error_message === "string" && native.error_message ? native.error_message : availability.reason,
    currentStateScoreImpact: "none",
  };
}

function selectRecent(
  usage: Sub2ApiUsageRow[],
  errors: Sub2ApiRequestError[],
  limit: number,
): { usage: Sub2ApiUsageRow[]; errors: Sub2ApiRequestError[] } {
  const selected = [
    ...usage.map((row) => ({ kind: "usage" as const, at: timestamp(row.created_at), row })),
    ...errors.map((row) => ({ kind: "error" as const, at: timestamp(row.created_at), row })),
  ].sort((left, right) => right.at - left.at).slice(0, limit);
  return {
    usage: selected.filter((item) => item.kind === "usage").map((item) => item.row as Sub2ApiUsageRow),
    errors: selected.filter((item) => item.kind === "error").map((item) => item.row as Sub2ApiRequestError),
  };
}

export async function collectRecentCallScores(
  client: Sub2ApiClient,
  recentCallLimit: number,
  accountSelector: string | null = null,
  onProgress: ((progress: { completed: number; total: number; accountId: number; accountName: string; remoteRequests: number }) => void) | null = null,
): Promise<{ ok: true; mode: string; recentCallLimit: number; accountCount: number; remoteRequests: number; accounts: Row[] }> {
  if (!Number.isInteger(recentCallLimit) || recentCallLimit < 1 || recentCallLimit > 1000) {
    throw new Error("recent call limit must be an integer from 1 to 1000");
  }
  const groups = await client.listGroups();
  let remoteRequests = 1;
  const memberships = new Map<number, AccountMembership>();
  const availabilityByGroup = new Map<number, { status: "available" | "unavailable"; data: Row; reason: string | null }>();
  for (const group of groups) {
    const accounts = await client.listGroupAccounts(group.id, group.platform);
    remoteRequests += 1;
    try {
      availabilityByGroup.set(group.id, {
        status: "available",
        data: await client.getOpsAccountAvailability(group.id, group.platform),
        reason: null,
      });
    } catch (error) {
      availabilityByGroup.set(group.id, {
        status: "unavailable",
        data: {},
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    remoteRequests += 1;
    for (const account of accounts) {
      const current = memberships.get(account.id);
      if (current) current.groups.push(group);
      else memberships.set(account.id, { account, groups: [group] });
    }
  }

  const rows: Row[] = [];
  const selectedMemberships = [...memberships.values()].filter(({ account }) => accountSelector === null
    || String(account.id) === accountSelector
    || account.name === accountSelector);
  if (accountSelector !== null && selectedMemberships.length !== 1) throw new Error(`account selector did not resolve exactly once: ${accountSelector}`);
  let completed = 0;
  for (const { account, groups: accountGroups } of selectedMemberships.sort((left, right) => left.account.id - right.account.id)) {
    // PK01 上每个唯一账号固定两次串行单页读取；评分和跨组聚合留在 NC01。
    const usage = await client.listRecentAccountUsage(account.id, recentCallLimit);
    remoteRequests += usage.requestCount;
    const errors = await client.listRecentAccountRequestErrors(account.id, account.platform, recentCallLimit);
    remoteRequests += errors.requestCount;
    const selected = selectRecent(usage.rows, errors.rows, recentCallLimit);
    const groupAvailability = availabilityByGroup.get(accountGroups[0]!.id)
      ?? { status: "unavailable" as const, data: {}, reason: "account availability was not collected" };
    const result = aggregateNativeGroupScore({
      group: accountGroups[0]!,
      // 最近调用质量分只评价历史调用；当前状态独立展示，绝不参与扣分。
      accounts: [{ ...account, status: "active", schedulable: true }],
      usage: selected.usage,
      requestErrors: selected.errors,
      systemLogs: [],
      overview: {},
      availability: { status: "unavailable", data: {}, reason: "current state is display-only in recent-call scoring" },
      concurrency: { status: "unavailable", data: {}, reason: "recent-call L0 mode does not query ops concurrency" },
    });
    rows.push({
      ...(result.accounts[0] ?? {}),
      ...currentState(groupAvailability, account),
      status: account.status,
      schedulable: account.schedulable,
      groupIds: accountGroups.map((group) => group.id),
      groupNames: accountGroups.map((group) => group.name),
      recentCallLimit,
      selectedCalls: selected.usage.length + selected.errors.length,
      evidenceMode: "recent-account-calls",
    });
    completed += 1;
    onProgress?.({ completed, total: selectedMemberships.length, accountId: account.id, accountName: account.name, remoteRequests });
  }
  return {
    ok: true,
    mode: "recent-account-calls-local-aggregation",
    recentCallLimit,
    accountCount: selectedMemberships.length,
    remoteRequests,
    accounts: mergeAccountScores(rows),
  };
}
