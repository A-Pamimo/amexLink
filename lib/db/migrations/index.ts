import type Database from "better-sqlite3";

export interface MigrationStep {
  /** Unique, increasing. `.sql` files take their id from the numeric filename prefix. */
  id: number;
  name: string;
  sql?: string;
  /** Code step, run after `sql` (if any) inside the same transaction. */
  up?: (db: Database.Database) => void;
}

/**
 * Code migrations (data rewrites that SQL alone cannot express).
 * `.sql` files in this directory are auto-discovered and merged with these,
 * sorted by id. Ids must not collide; they are never renumbered.
 * Reserved: 0003 auth (WP2), 0004 token_ct (WP3), 0005 item_status (WP4),
 * 0006 card_liabilities (WP6a).
 */
export const steps: MigrationStep[] = [];
