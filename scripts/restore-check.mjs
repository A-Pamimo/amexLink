#!/usr/bin/env node
// Restore drill (SECURITY.md 3.8 step 5): prove an encrypted backup can be
// opened, without touching the live database and without printing any secret.
//
//   AGE_IDENTITY_FILE=/path/to/amexlens-backup.key npm run restore:check -- data/backups/amexlens-<stamp>.sqlite.age
//
// Decrypts to a 0600 temp file, opens it read-only, prints the applied
// migration ids and COUNT(*) of plaid_items, then deletes the temp file (and
// the -wal/-shm SQLite creates beside it). Never selects a token column.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as age from "age-encryption";
import { log } from "./log.mjs";

process.umask(0o077);

const file = process.argv[2];
const identityFile = (process.env.AGE_IDENTITY_FILE ?? "").trim();

function readIdentities(p) {
  // age-keygen output: comment lines starting with '#', then AGE-SECRET-KEY-1...
  return fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("AGE-SECRET-KEY-1"));
}

async function main() {
  if (!file) {
    log.error("restore_check_refused", { reason: "usage: restore-check.mjs <backup.sqlite.age>" });
    process.exit(2);
  }
  if (!identityFile) {
    log.error("restore_check_refused", { reason: "AGE_IDENTITY_FILE is not set" });
    process.exit(2);
  }
  const identities = readIdentities(identityFile);
  if (identities.length === 0) {
    log.error("restore_check_refused", { reason: "no AGE-SECRET-KEY-1 line in AGE_IDENTITY_FILE" });
    process.exit(2);
  }

  const decrypter = new age.Decrypter();
  for (const id of identities) decrypter.addIdentity(id);
  const plaintext = await decrypter.decrypt(new Uint8Array(fs.readFileSync(file)));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amexlens-restore-"));
  const tmpDb = path.join(tmpDir, "restore.sqlite");
  let db = null;
  try {
    fs.writeFileSync(tmpDb, plaintext, { mode: 0o600 });
    db = new Database(tmpDb, { readonly: true });
    const migrations = db
      .prepare("SELECT id FROM _migrations ORDER BY id")
      .all()
      .map((r) => r.id);
    const items = db.prepare("SELECT COUNT(*) AS n FROM plaid_items").get().n;
    const ok = db.pragma("integrity_check", { simple: true });
    db.close();
    db = null;
    log.info("restore_check_ok", {
      file,
      migrations: migrations.join(","),
      items,
      integrity: ok,
    });
    // Plain summary line for humans / tests.
    process.stdout.write(`migrations=${migrations.join(",")} items=${items} integrity=${ok}\n`);
  } finally {
    if (db && db.open) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  log.error("restore_check_failed", { error: err });
  process.exit(1);
});
