import type Database from "better-sqlite3";
import { encrypt } from "../../crypto";

export interface MigrationStep {
  /** Unique, increasing. `.sql` files take their id from the numeric filename prefix. */
  id: number;
  name: string;
  sql?: string;
  /**
   * Code step, run after `sql` (if any) inside the same transaction.
   * May return a short, non-secret detail string (e.g. a row count) that
   * `migrate()` reports back to the caller.
   */
  up?: (db: Database.Database) => void | string;
}

/** Fixed id of the token_ct step; `createSqliteDB` runs VACUUM when it applies. */
export const TOKEN_CT_MIGRATION_ID = 4;

interface ColumnInfo {
  name: string;
}

function columns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return new Set(rows.map((c) => c.name));
}

/**
 * 0004 token_ct (WP3, SECURITY.md 3.2 / F-03): move Plaid access tokens from
 * the plaintext `access_token` column into `access_token_ct` (AES-256-GCM via
 * lib/crypto, AAD `plaid_items:<item_id>`), then drop the plaintext column.
 *
 * Guarded with PRAGMA table_info so a re-run (or a DB where the column is
 * already gone) is a no-op. Requires SQLite >= 3.35 for DROP COLUMN. VACUUM
 * cannot run inside this transaction; `createSqliteDB` runs it afterwards so
 * the freed pages holding plaintext are actually rewritten.
 */
function tokenCtUp(db: Database.Database): string {
  let cols = columns(db, "plaid_items");
  if (!cols.has("access_token_ct")) {
    db.exec(`ALTER TABLE plaid_items ADD COLUMN access_token_ct TEXT`);
    cols = columns(db, "plaid_items");
  }
  let n = 0;
  if (cols.has("access_token")) {
    const rows = db
      .prepare(
        `SELECT item_id, access_token FROM plaid_items WHERE access_token_ct IS NULL`
      )
      .all() as Array<{ item_id: string; access_token: string | null }>;
    const update = db.prepare(
      `UPDATE plaid_items SET access_token_ct = ? WHERE item_id = ?`
    );
    for (const r of rows) {
      if (r.access_token === null) continue;
      update.run(encrypt(r.access_token, `plaid_items:${r.item_id}`), r.item_id);
      n++;
    }
    db.exec(`ALTER TABLE plaid_items DROP COLUMN access_token`);
  }
  return `${n} rows`;
}

/**
 * Code migrations (data rewrites that SQL alone cannot express).
 * `.sql` files in this directory are auto-discovered and merged with these,
 * sorted by id. Ids must not collide; they are never renumbered.
 * Reserved: 0003 auth (WP2), 0004 token_ct (WP3), 0005 item_status (WP4),
 * 0006 card_liabilities (WP6a).
 */
export const steps: MigrationStep[] = [
  { id: TOKEN_CT_MIGRATION_ID, name: "token_ct", up: tokenCtUp },
];
