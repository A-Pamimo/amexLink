import "server-only";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../../db";
import { log } from "../../log";
import {
  steps as codeSteps,
  TOKEN_CT_MIGRATION_ID,
  type MigrationStep,
} from "../migrations";
import { coreRepo } from "./core";
import { itemsRepo } from "./items";
import { statsRepo } from "./stats";
import { transactionsRepo } from "./transactions";

function ensureDir(p: string) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Owner-only modes for the DB directory and files (SECURITY.md 3.2, F-12).
 * Does not trust umask. Best effort: a chmod failure (foreign FS) must not
 * stop the app, so errors are swallowed; win32 has no POSIX modes and is skipped.
 */
export function hardenFileModes(dbPath: string): void {
  if (process.platform === "win32") return;
  const tryChmod = (p: string, mode: number) => {
    try {
      if (fs.existsSync(p)) fs.chmodSync(p, mode);
    } catch {
      // best effort
    }
  };
  tryChmod(path.dirname(dbPath), 0o700);
  tryChmod(dbPath, 0o600);
  tryChmod(`${dbPath}-wal`, 0o600);
  tryChmod(`${dbPath}-shm`, 0o600);
}

// Migrations dir is resolved from process.cwd() on purpose: under `next build`
// this module is bundled into .next/server, so import.meta.url / __dirname would
// point at build output, not at the source tree holding the .sql files.
// `next start`, `next dev`, scripts and vitest all run with cwd = repo root.
export function migrationsDir(): string {
  return path.join(process.cwd(), "lib", "db", "migrations");
}

function discoverSqlSteps(dir: string): MigrationStep[] {
  if (!fs.existsSync(dir)) return [];
  const out: MigrationStep[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".sql")) continue;
    const id = parseInt(file.split("_")[0], 10);
    if (Number.isNaN(id)) continue;
    out.push({
      id,
      name: file.replace(/\.sql$/, ""),
      sql: fs.readFileSync(path.join(dir, file), "utf8"),
    });
  }
  return out;
}

/** Merge code steps with auto-discovered .sql files; ids must be unique. */
export function collectMigrations(dir: string = migrationsDir()): MigrationStep[] {
  const all = [...discoverSqlSteps(dir), ...codeSteps];
  const seen = new Set<number>();
  for (const s of all) {
    if (seen.has(s.id)) throw new Error(`Duplicate migration id ${s.id} (${s.name})`);
    seen.add(s.id);
  }
  return all.sort((a, b) => a.id - b.id);
}

export interface AppliedMigration {
  id: number;
  name: string;
  /** Non-secret detail returned by a code step (e.g. "2 rows"). */
  detail?: string;
}

/** Applies pending steps and returns the ones applied in this call. */
export function migrate(
  db: Database.Database,
  dir: string = migrationsDir()
): AppliedMigration[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (db.prepare(`SELECT id FROM _migrations`).all() as Array<{ id: number }>).map(
      (r) => r.id
    )
  );
  const insert = db.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`);
  const ran: AppliedMigration[] = [];
  for (const step of collectMigrations(dir)) {
    if (applied.has(step.id)) continue;
    // Each step runs in its own transaction and is recorded atomically with its effects.
    db.transaction(() => {
      let detail: string | undefined;
      if (step.sql) db.exec(step.sql);
      if (step.up) {
        const r = step.up(db);
        if (typeof r === "string") detail = r;
      }
      insert.run(step.id, new Date().toISOString());
      ran.push({ id: step.id, name: step.name, detail });
    })();
  }
  return ran;
}

export function createSqliteDB(dbPath: string): DB {
  ensureDir(dbPath);
  const db = new Database(dbPath);
  hardenFileModes(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const ran = migrate(db);
  hardenFileModes(dbPath);

  const core = coreRepo(db);

  const tokenCt = ran.find((m) => m.id === TOKEN_CT_MIGRATION_ID);
  if (tokenCt) {
    // The plaintext column is gone from the schema, but its bytes still sit in
    // freed page space until the file is rebuilt. VACUUM must run outside the
    // migration transaction; the checkpoint then drops the pre-VACUUM WAL frames.
    db.exec("VACUUM");
    db.pragma("wal_checkpoint(TRUNCATE)");
    hardenFileModes(dbPath);
    const detail = tokenCt.detail ?? "0 rows";
    // lib/audit's audit() calls getDB(), which is still constructing this
    // instance; write the identical security_log row through the core repo.
    void core.appendSecurityLog({ event: "token_migration", outcome: "ok", detail });
    if (detail.startsWith("0 ")) {
      // Fresh database: the plaintext column existed only inside this migration.
      log.info("token_migration", { rows: detail });
    } else {
      log.warn("token_migration", {
        rows: detail,
        message:
          "Plaintext token column removed; destroy old backups under data/backups/ and run scripts/verify-no-plaintext.mjs",
      });
    }
  }

  return {
    ...itemsRepo(db),
    ...transactionsRepo(db),
    ...statsRepo(db),
    ...core,
  };
}
