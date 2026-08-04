import {
  normalizeManualPriorityAssignments,
  type ManualPriorityAssignments,
} from "../../../../src/manual-priority-plan";

export function parseManualPriorityAssignments(input: string): ManualPriorityAssignments {
  const priorities: Record<string, number> = {};
  for (const rawEntry of input.split(",")) {
    const entry = rawEntry.trim();
    const match = /^(\d+):(\d+)$/u.exec(entry);
    if (!match) throw new Error(`invalid --priorities entry: ${entry || "<empty>"}; expected ACCOUNT_ID:PRIORITY`);
    const accountId = String(Number(match[1]));
    if (Object.hasOwn(priorities, accountId)) throw new Error(`duplicate --priorities account ID: ${accountId}`);
    priorities[accountId] = Number(match[2]);
  }
  return normalizeManualPriorityAssignments(priorities);
}
