export interface Sub2ApiUser {
  id: number;
  email: string;
  username: string;
  role: string;
  status: string;
  balance: number;
  last_active_at?: string | null;
}

export interface RankingSourceRow {
  user_id: number;
  email: string;
  actual_cost: number;
  requests: number;
  tokens: number;
}

export interface PublicRankingRow {
  rank: number;
  displayName: string;
  actualCost: number;
  requests: number;
  tokens: number;
  balanceUsd: number;
  rechargeCny: number;
}

export interface PublicDrawRecord {
  id: string;
  drawnAt: string;
  eligibleCount: number;
  winnerDisplayName: string;
  prizeAmountUsd: number;
  creditStatus: DrawRecord["creditStatus"];
}

export interface DrawRecord {
  id: string;
  drawnAt: string;
  eligibleCount: number;
  winnerUserId: number;
  winnerDisplayName: string;
  prizeAmountUsd: number;
  creditStatus: "disabled" | "dry_run" | "pending" | "succeeded" | "failed";
  creditMessage: string | null;
}
