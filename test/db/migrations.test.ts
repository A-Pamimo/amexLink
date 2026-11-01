import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { closeApp, loadApp } from "../helpers/app";

afterEach(() => closeApp());

describe("migrations", () => {
  it("applies 0001, 0002 and the 0004 token_ct code step on a fresh DB", async () => {
    const { dir } = await loadApp();
    const raw = new Database(path.join(dir, "test.sqlite"), { readonly: true });
    const ids = (raw.prepare("SELECT id FROM _migrations ORDER BY id").all() as Array<{ id: number }>).map(
      (r) => r.id
    );
    expect(ids).toEqual([1, 2, 4]);

    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of ["plaid_items", "transactions", "settings", "security_log"]) {
      expect(tables).toContain(t);
    }
    raw.close();
  });

  it("merges code steps with .sql files, sorted by id, one transaction each", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const { migrate } = await import("@/lib/db/sqlite");
    const migrations = await import("@/lib/db/migrations");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amexlens-mig-"));
    fs.writeFileSync(path.join(dir, "0001_a.sql"), "CREATE TABLE a (x INTEGER);");
    fs.writeFileSync(path.join(dir, "0003_c.sql"), "CREATE TABLE c (x INTEGER);");
    const order: string[] = [];
    // Swap the real code steps (0004 token_ct) out for this synthetic set.
    const realSteps = migrations.steps.splice(0, migrations.steps.length);
    migrations.steps.push(
      {
        id: 2,
        name: "b_code",
        up: (db) => {
          order.push("2");
          db.exec("CREATE TABLE b (x INTEGER)");
        },
      },
      {
        id: 4,
        name: "d_fails",
        up: (db) => {
          db.exec("CREATE TABLE d (x INTEGER)");
          throw new Error("boom");
        },
      }
    );

    const db = new Database(":memory:");
    try {
      expect(() => migrate(db, dir)).toThrow("boom");
      const ids = (db.prepare("SELECT id FROM _migrations ORDER BY id").all() as Array<{ id: number }>).map(
        (r) => r.id
      );
      expect(ids).toEqual([1, 2, 3]);
      // failed step rolled back entirely
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'd'").get()).toBeUndefined();
      expect(order).toEqual(["2"]);
    } finally {
      db.close();
      migrations.steps.splice(0, migrations.steps.length, ...realSteps);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate migration ids", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const { collectMigrations } = await import("@/lib/db/sqlite");
    const migrations = await import("@/lib/db/migrations");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amexlens-mig-"));
    fs.writeFileSync(path.join(dir, "0001_a.sql"), "SELECT 1;");
    const realSteps = migrations.steps.splice(0, migrations.steps.length);
    migrations.steps.push({ id: 1, name: "dup", sql: "SELECT 1;" });
    try {
      expect(() => collectMigrations(dir)).toThrow(/Duplicate migration id 1/);
    } finally {
      migrations.steps.splice(0, migrations.steps.length, ...realSteps);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
