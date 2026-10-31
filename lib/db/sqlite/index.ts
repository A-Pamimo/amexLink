import "server-only";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../../db";
import { steps as codeSteps, type MigrationStep } from "../migrations";
import { authRepo } from "./auth";
import { coreRepo } from "./core";
import { itemsRepo } from "./items";
import { statsRepo } from "./stats";
import { transactionsRepo } from "./transactions";

function ensureDir(p: string) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

export function migrate(db: Database.Database, dir: string = migrationsDir()) {
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
  for (const step of collectMigrations(dir)) {
    if (applied.has(step.id)) continue;
    // Each step runs in its own transaction and is recorded atomically with its effects.
    db.transaction(() => {
      if (step.sql) db.exec(step.sql);
      if (step.up) step.up(db);
      insert.run(step.id, new Date().toISOString());
    })();
  }
}

export function createSqliteDB(dbPath: string): DB {
  ensureDir(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);

  return {
    ...itemsRepo(db),
    ...transactionsRepo(db),
    ...statsRepo(db),
    ...coreRepo(db),
    ...authRepo(db),
  };
}
