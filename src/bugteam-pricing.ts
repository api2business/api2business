export interface BugTeamShelfSelection {
  available: number;
  unitPriceFen: number;
  remainingSeconds: number;
  bucketStart: string;
}

function numberField(value: unknown, field: string, minimum = 0): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) throw new Error(`BugTeam field ${field} is invalid`);
  return number;
}

function tieredUnitPriceFen(baseUnitPriceFen: number, remainingSeconds: number, billingBaseSeconds: number): number {
  const base = Math.trunc(baseUnitPriceFen);
  const remaining = Math.trunc(remainingSeconds);
  const span = Math.trunc(billingBaseSeconds);
  return remaining >= span / 2 ? base : Math.round(base * 2 / 3);
}

export function selectLowestBugTeamShelf(
  shelves: Record<string, unknown>,
  pricing: Record<string, unknown>,
  quantity: number,
): BugTeamShelfSelection | null {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("BugTeam quantity must be a positive integer");
  if (!Array.isArray(shelves.buckets)) throw new Error("BugTeam shelves field buckets is invalid");
  const baseUnitPriceFen = numberField(pricing.base_unit_price_fen, "base_unit_price_fen", 1);
  const billingBaseSeconds = numberField(pricing.billing_base_seconds, "billing_base_seconds", 1);
  const candidates = shelves.buckets.flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`BugTeam shelf ${index} is invalid`);
    const shelf = value as Record<string, unknown>;
    const available = numberField(shelf.available, `buckets[${index}].available`);
    if (!Number.isInteger(available)) throw new Error(`BugTeam shelf ${index} available is invalid`);
    if (available < quantity) return [];
    const remainingSeconds = numberField(shelf.minimum_remaining_seconds, `buckets[${index}].minimum_remaining_seconds`, 1);
    const bucketStart = String(shelf.bucket_start ?? "");
    if (!bucketStart) return [];
    return [{
      available,
      remainingSeconds,
      unitPriceFen: tieredUnitPriceFen(baseUnitPriceFen, remainingSeconds, billingBaseSeconds),
      bucketStart,
    }];
  });
  candidates.sort((left, right) => left.unitPriceFen - right.unitPriceFen
    || left.remainingSeconds - right.remainingSeconds
    || left.bucketStart.localeCompare(right.bucketStart));
  return candidates[0] ?? null;
}
