#!/usr/bin/env node
// Encrypted, consistent SQLite backup (SECURITY.md 3.8).
//
//   npm run backup                    -> data/backups/amexlens-<stamp>.sqlite.age
//   npm run backup -- --purge-plaintext   also deletes legacy plaintext *.sqlite backups
//
// Env: DB_PATH (default data/amexlens.sqlite), BACKUP_AGE_RECIPIENT (required,
// an age public key "age1..."), BACKUP_DIR (default <dirname(DB_PATH)>/backups),
// BACKUP_KEEP (default 7).
//
// Steps: open the live DB read-only, snapshot it with the online backup API
// (consistent even under WAL), encrypt the snapshot to the recipient, write the
// .age file with mode 0600, delete the plaintext snapshot in `finally`, keep the
// newest BACKUP_KEEP .age files. The age private key is never read here.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as age from "age-encryption";
import { log } from "./log.mjs";

process.umask(0o077);

const args = new Set(process.argv.slice(2));
const dbPath = process.env.DB_PATH ?? "data/amexlens.sqlite";
const backupsDir = process.env.BACKUP_DIR ?? path.join(path.dirname(dbPath), "backups");
const keep = Math.max(1, parseInt(process.env.BACKUP_KEEP ?? "7", 10) || 7);
const recipient = (process.env.BACKUP_AGE_RECIPIENT ?? "").trim();

function purgePlaintext() {
  if (!fs.existsSync(backupsDir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(backupsDir)) {
    if (/\.sqlite(-wal|-shm|-journal)?$/.test(f)) {
      fs.rmSync(path.join(backupsDir, f), { force: true });
      n++;
    }
  }
  return n;
}

function prune() {
  const ageFiles = fs
    .readdirSync(backupsDir)
    .filter((f) => f.endsWith(".sqlite.age"))
    .sort()
    .reverse();
  const removed = [];
  for (const f of ageFiles.slice(keep)) {
    fs.rmSync(path.join(backupsDir, f), { force: true });
    removed.push(f);
  }
  return removed;
}

async function main() {
  if (!recipient) {
    log.error("backup_refused", {
      reason: "BACKUP_AGE_RECIPIENT is not set; refusing to write a plaintext backup",
      hint: "age-keygen -o amexlens-backup.key (keep it OFF this host) and put its public key in BACKUP_AGE_RECIPIENT",
    });
    process.exit(2);
  }
  if (!recipient.startsWith("age1")) {
    log.error("backup_refused", { reason: "BACKUP_AGE_RECIPIENT does not look like an age public key" });
    process.exit(2);
  }
  if (!fs.existsSync(dbPath)) {
    log.error("backup_refused", { reason: "database file not found", db_path: dbPath });
    process.exit(1);
  }
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(backupsDir, 0o700);
  } catch {
    // best effort
  }

  if (args.has("--purge-plaintext")) {
    const n = purgePlaintext();
    log.info("backup_purged_plaintext", { dir: backupsDir, files: n });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(backupsDir, `amexlens-${stamp}.sqlite.age`);
  const tmpPath = path.join(backupsDir, `.amexlens-${stamp}.tmp.sqlite`);

  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(tmpPath);
    db.close();

    const encrypter = new age.Encrypter();
    encrypter.addRecipient(recipient);
    const plaintext = fs.readFileSync(tmpPath);
    const ciphertext = await encrypter.encrypt(new Uint8Array(plaintext));
    plaintext.fill(0);

    fs.writeFileSync(outPath, ciphertext, { mode: 0o600 });
    fs.chmodSync(outPath, 0o600);
  } finally {
    if (db.open) db.close();
    for (const p of [tmpPath, `${tmpPath}-journal`, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
      fs.rmSync(p, { force: true });
    }
  }

  const pruned = prune();
  log.info("backup_ok", {
    file: outPath,
    bytes: fs.statSync(outPath).size,
    kept: keep,
    pruned: pruned.length,
  });
}

main().catch((err) => {
  log.error("backup_failed", { error: err });
  process.exit(1);
});
