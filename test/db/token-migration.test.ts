import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeApp, loadApp } from "../helpers/app";

const migrationsDir = path.join(__dirname, "..", "..", "lib", "db", "migrations");

let fixtureDir: string | null = null;

afterEach(() => {
  closeApp();
  if (fixtureDir) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = null;
  }
});

/** A pre-WP3 database: only 0001 + 0002 applied, tokens in the plaintext column. */
function buildLegacyFixture(): string {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "amexlens-legacy-"));
  const dbPath = path.join(fixtureDir, "legacy.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(fs.readFileSync(path.join(migrationsDir, "0001_init.sql"), "utf8"));
  db.exec(fs.readFileSync(path.join(migrationsDir, "0002_core.sql"), "utf8"));
  db.exec(`CREATE TABLE _migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (1, ?), (2, ?)`).run(now, now);
  const ins = db.prepare(`
    INSERT INTO plaid_items (id, access_token, item_id, institution_name, institution_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  ins.run("row-a", "access-sandbox-aaa", "item-a", "Amex Canada", "ins_100533", now);
  ins.run("row-b", "access-sandbox-bbb", "item-b", "RBC", "ins_2", now);
  db.close();
  return dbPath;
}

function columnNames(dbPath: string): string[] {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return (raw.prepare("PRAGMA table_info(plaid_items)").all() as Array<{ name: string }>).map(
      (c) => c.name
    );
  } finally {
    raw.close();
  }
}

describe("migration 0004 token_ct", () => {
  it("encrypts legacy plaintext tokens, drops the column and leaves no plaintext on disk", async () => {
    const dbPath = buildLegacyFixture();
    const before = fs.readFileSync(dbPath);
    expect(before.includes("access-sandbox-aaa")).toBe(true);

    const { db } = await loadApp({ DB_PATH: dbPath });

    const cols = columnNames(dbPath);
    expect(cols).toContain("access_token_ct");
    expect(cols).not.toContain("access_token");

    expect(await db.getItemSecret("item-a")).toEqual({ access_token: "access-sandbox-aaa" });
    expect(await db.getItemSecret("item-b")).toEqual({ access_token: "access-sandbox-bbb" });

    const raw = new Database(dbPath);
    try {
      raw.pragma("wal_checkpoint(TRUNCATE)");
      const ids = (raw.prepare("SELECT id FROM _migrations ORDER BY id").all() as Array<{ id: number }>).map(
        (r) => r.id
      );
      expect(ids).toEqual([1, 2, 4, 5]);

      const ct = raw.prepare("SELECT access_token_ct FROM plaid_items WHERE item_id = 'item-a'").get() as {
        access_token_ct: string;
      };
      expect(ct.access_token_ct.startsWith("v1.")).toBe(true);

      const auditRows = raw
        .prepare("SELECT event, outcome, detail FROM security_log WHERE event = 'token_migration'")
        .all() as Array<{ event: string; outcome: string; detail: string }>;
      expect(auditRows).toEqual([{ event: "token_migration", outcome: "ok", detail: "2 rows" }]);
    } finally {
      raw.close();
    }

    for (const file of [dbPath, `${dbPath}-wal`]) {
      if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file);
      expect(bytes.includes("access-sandbox-")).toBe(false);
    }
  });

  it("is a no-op when run again on a migrated database", async () => {
    const dbPath = buildLegacyFixture();
    await loadApp({ DB_PATH: dbPath });
    closeApp();
    const { db } = await loadApp({ DB_PATH: dbPath });
    expect(await db.getItemSecret("item-b")).toEqual({ access_token: "access-sandbox-bbb" });
    const raw = new Database(dbPath, { readonly: true });
    try {
      const n = raw.prepare("SELECT COUNT(*) AS n FROM security_log WHERE event = 'token_migration'").get() as {
        n: number;
      };
      expect(n.n).toBe(1);
    } finally {
      raw.close();
    }
  });

  it("fresh databases get access_token_ct only and store ciphertext on insert", async () => {
    const { db, dir } = await loadApp();
    const dbPath = path.join(dir, "test.sqlite");
    const cols = columnNames(dbPath);
    expect(cols).toContain("access_token_ct");
    expect(cols).not.toContain("access_token");

    await db.insertItem({
      id: "row-1",
      access_token: "access-sandbox-fresh-1",
      item_id: "item-1",
      institution_name: null,
      institution_id: null,
    });
    const raw = new Database(dbPath);
    try {
      raw.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      raw.close();
    }
    expect(fs.readFileSync(dbPath).includes("access-sandbox-")).toBe(false);
    expect(await db.getItemSecret("item-1")).toEqual({ access_token: "access-sandbox-fresh-1" });
  });

  it("getItemSecret throws TokenUnreadableError (without ciphertext) when the row cannot be decrypted", async () => {
    const { db, dir } = await loadApp();
    const dbPath = path.join(dir, "test.sqlite");
    await db.insertItem({
      id: "row-1",
      access_token: "access-sandbox-xyz",
      item_id: "item-1",
      institution_name: null,
      institution_id: null,
    });
    // Simulate a swapped / tampered row: ciphertext copied from another item id.
    const raw = new Database(dbPath);
    const ct = (raw.prepare("SELECT access_token_ct FROM plaid_items WHERE item_id = 'item-1'").get() as {
      access_token_ct: string;
    }).access_token_ct;
    raw.prepare(
      "INSERT INTO plaid_items (id, access_token_ct, item_id, created_at) VALUES ('row-2', ?, 'item-2', ?)"
    ).run(ct, new Date().toISOString());
    raw.close();

    const { TokenUnreadableError } = await import("@/lib/errors");
    let caught: unknown;
    try {
      await db.getItemSecret("item-2");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TokenUnreadableError);
    expect((caught as Error).message).not.toContain(ct);
    expect((caught as Error).message).not.toContain("access-sandbox-");
  });
});
