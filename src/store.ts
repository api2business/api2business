import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DateTime } from "luxon";
import type { AppConfig } from "./config";
import type { DrawRecord } from "./types";

interface StoredRecordRow {
  id: string;
  drawn_at: string;
  eligible_count: number;
  winner_user_id: number;
  winner_display_name: string;
  prize_amount_usd: number;
  credit_status: DrawRecord["creditStatus"];
  credit_message: string | null;
}

export class LotteryStore {
  private readonly db: Database;

  constructor(private readonly config: AppConfig, path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS draw_records (
        id TEXT PRIMARY KEY,
        drawn_at TEXT NOT NULL,
        eligible_count INTEGER NOT NULL,
        winner_user_id INTEGER NOT NULL,
        winner_display_name TEXT NOT NULL,
        prize_amount_usd REAL NOT NULL,
        credit_status TEXT NOT NULL,
        credit_message TEXT
      );
      CREATE INDEX IF NOT EXISTS draw_records_drawn_at ON draw_records(drawn_at DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  private meta(key: string): string | null {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  private latestGrant(now: Date): DateTime {
    const zone = this.config.lottery.timezone;
    const local = DateTime.fromJSDate(now, { zone });
    let grant = local.set({ hour: this.config.lottery.dailyGrant.hour, minute: this.config.lottery.dailyGrant.minute, second: 0, millisecond: 0 });
    if (grant > local) grant = grant.minus({ days: 1 });
    return grant;
  }

  reconcileGrants(now = new Date()): { remainingDraws: number; nextGrantAt: string; added: number } {
    return this.db.transaction(() => {
      const latest = this.latestGrant(now);
      const latestKey = latest.toISODate();
      if (!latestKey) throw new Error("failed to calculate latest grant key");
      const previousKey = this.meta("last_grant_key");
      let remaining = Number(this.meta("remaining_draws") ?? "0");
      let added = 0;
      if (previousKey === null) {
        remaining = this.config.lottery.initialDrawCount;
        this.setMeta("last_grant_key", latestKey);
        this.setMeta("remaining_draws", String(remaining));
      } else {
        const previous = DateTime.fromISO(previousKey, { zone: this.config.lottery.timezone }).startOf("day");
        const days = Math.max(0, Math.round(latest.startOf("day").diff(previous, "days").days));
        added = days * this.config.lottery.dailyGrant.count;
        if (added > 0) {
          remaining += added;
          this.setMeta("last_grant_key", latestKey);
          this.setMeta("remaining_draws", String(remaining));
        }
      }
      const nextGrantAt = latest.plus({ days: 1 }).toUTC().toISO();
      if (!nextGrantAt) throw new Error("failed to calculate next grant time");
      return { remainingDraws: remaining, nextGrantAt, added };
    })();
  }

  createDraw(record: DrawRecord): void {
    this.db.transaction(() => {
      const remaining = Number(this.meta("remaining_draws") ?? "0");
      if (remaining < 1) throw new Error("no draw chance is available");
      this.db.query(`INSERT INTO draw_records(
        id, drawn_at, eligible_count, winner_user_id, winner_display_name, prize_amount_usd, credit_status, credit_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.id,
        record.drawnAt,
        record.eligibleCount,
        record.winnerUserId,
        record.winnerDisplayName,
        record.prizeAmountUsd,
        record.creditStatus,
        record.creditMessage,
      );
      this.setMeta("remaining_draws", String(remaining - 1));
    })();
  }

  updateCredit(id: string, status: DrawRecord["creditStatus"], message: string | null): void {
    const result = this.db.query("UPDATE draw_records SET credit_status = ?, credit_message = ? WHERE id = ?").run(status, message, id);
    if (result.changes !== 1) throw new Error(`draw record ${id} does not exist`);
  }

  listRecords(limit: number): DrawRecord[] {
    const rows = this.db.query<StoredRecordRow, [number]>("SELECT * FROM draw_records ORDER BY drawn_at DESC LIMIT ?").all(limit);
    return rows.map((row) => ({
      id: row.id,
      drawnAt: row.drawn_at,
      eligibleCount: row.eligible_count,
      winnerUserId: row.winner_user_id,
      winnerDisplayName: row.winner_display_name,
      prizeAmountUsd: row.prize_amount_usd,
      creditStatus: row.credit_status,
      creditMessage: row.credit_message,
    }));
  }

  deleteRecord(id: string): boolean {
    return this.db.query("DELETE FROM draw_records WHERE id = ?").run(id).changes === 1;
  }

  resetData(draws: number, includeRecords: boolean, now = new Date()): { remainingDraws: number; recordsDeleted: number } {
    return this.db.transaction(() => {
      const deleted = includeRecords ? this.db.query("DELETE FROM draw_records").run().changes : 0;
      const latestKey = this.latestGrant(now).toISODate();
      if (!latestKey) throw new Error("failed to calculate reset grant key");
      this.setMeta("last_grant_key", latestKey);
      this.setMeta("remaining_draws", String(draws));
      return { remainingDraws: draws, recordsDeleted: deleted };
    })();
  }
}
