import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as age from "age-encryption";
import { closeApp, loadApp } from "../helpers/app";

const repoRoot = path.join(__dirname, "..", "..");
const script = (name: string) => path.join(repoRoot, "scripts", name);
const posix = process.platform !== "win32";

let keyDir: string;
let identityFile: string;
let recipient: string;

beforeAll(async () => {
  // Test-only age keypair; written to a temp dir, never to the repo.
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "amexlens-age-"));
  const identity = await age.generateIdentity();
  recipient = await age.identityToRecipient(identity);
  identityFile = path.join(keyDir, "identity.txt");
  fs.writeFileSync(
    identityFile,
    `# created: test\n# public key: ${recipient}\n${identity}\n`,
    { mode: 0o600 }
  );
});

afterEach(() => closeApp());

function run(name: string, args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, [script(name), ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("backup / restore drill scripts", () => {
  it("backs up to an age file, restore-check opens it, and no plaintext remains", async () => {
    const { db, dir } = await loadApp();
    const dbPath = path.join(dir, "test.sqlite");
    await db.insertItem({
      id: "row-1",
      access_token: "access-sandbox-backup-token-1",
      item_id: "item-1",
      institution_name: "Amex Canada",
      institution_id: "ins_100533",
    });
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(backupDir);
    // Legacy plaintext backup that --purge-plaintext must remove.
    const legacy = path.join(backupDir, "amexlens-2026-01-01T00-00-00-000Z.sqlite");
    fs.writeFileSync(legacy, "access-sandbox-legacy-plaintext");
    const env = { DB_PATH: dbPath, BACKUP_AGE_RECIPIENT: recipient, BACKUP_DIR: backupDir };

    // Refuses without a recipient.
    const refused = run("backup.mjs", [], { DB_PATH: dbPath, BACKUP_DIR: backupDir, BACKUP_AGE_RECIPIENT: "" });
    expect(refused.status).toBe(2);
    expect(fs.readdirSync(backupDir).filter((f) => f.endsWith(".age"))).toHaveLength(0);

    const backup = run("backup.mjs", ["--purge-plaintext"], env);
    expect(backup.status, backup.stderr).toBe(0);
    expect(backup.stdout).toContain('"event":"backup_ok"');
    expect(backup.stdout + backup.stderr).not.toContain("access-sandbox-");

    const files = fs.readdirSync(backupDir);
    const ageFiles = files.filter((f) => /^amexlens-.*\.sqlite\.age$/.test(f));
    expect(ageFiles).toHaveLength(1);
    expect(fs.existsSync(legacy)).toBe(false);
    // No plaintext temp snapshot left behind.
    expect(files.filter((f) => !f.endsWith(".age"))).toEqual([]);
    const agePath = path.join(backupDir, ageFiles[0]);
    if (posix) expect(fs.statSync(agePath).mode & 0o777).toBe(0o600);
    // The age file itself is ciphertext.
    expect(fs.readFileSync(agePath).includes("access-sandbox-")).toBe(false);
    expect(fs.readFileSync(agePath).subarray(0, 21).toString()).toBe("age-encryption.org/v1");

    const restore = run("restore-check.mjs", [agePath], { AGE_IDENTITY_FILE: identityFile });
    expect(restore.status, restore.stderr).toBe(0);
    expect(restore.stdout).toContain("migrations=1,2,4");
    expect(restore.stdout).toContain("items=1");
    expect(restore.stdout + restore.stderr).not.toContain("access-sandbox-");
    // restore-check leaves no decrypted copy in the temp dir.
    expect(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("amexlens-restore-"))).toEqual([]);

    // Wrong identity cannot open it.
    const otherIdentity = await age.generateIdentity();
    const otherFile = path.join(keyDir, "other.txt");
    fs.writeFileSync(otherFile, `${otherIdentity}\n`, { mode: 0o600 });
    const bad = run("restore-check.mjs", [agePath], { AGE_IDENTITY_FILE: otherFile });
    expect(bad.status).toBe(1);

    // Live data dir (DB + encrypted backups) is clean; a planted token is caught.
    const clean = run("verify-no-plaintext.mjs", [dir], {});
    expect(clean.status, clean.stderr).toBe(0);

    const planted = fs.mkdtempSync(path.join(os.tmpdir(), "amexlens-planted-"));
    try {
      fs.mkdirSync(path.join(planted, "backups"));
      fs.writeFileSync(path.join(planted, "backups", "old.sqlite"), Buffer.concat([
        Buffer.alloc(100, 0),
        Buffer.from("access-sandbox-planted-xyz"),
      ]));
      const dirty = run("verify-no-plaintext.mjs", [planted], {});
      expect(dirty.status).toBe(1);
      expect(dirty.stderr).toContain("old.sqlite");
      expect(dirty.stderr).not.toContain("planted-xyz");
    } finally {
      fs.rmSync(planted, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps only the newest 7 .age files", async () => {
    const { dir } = await loadApp();
    const dbPath = path.join(dir, "test.sqlite");
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(backupDir);
    for (let i = 0; i < 9; i++) {
      fs.writeFileSync(path.join(backupDir, `amexlens-2026-01-0${i}T00-00-00-000Z.sqlite.age`), "x");
    }
    const r = run("backup.mjs", [], { DB_PATH: dbPath, BACKUP_AGE_RECIPIENT: recipient, BACKUP_DIR: backupDir });
    expect(r.status, r.stderr).toBe(0);
    const left = fs.readdirSync(backupDir).filter((f) => f.endsWith(".age")).sort();
    expect(left).toHaveLength(7);
    // The three oldest fakes are gone; the fresh backup (latest stamp) is kept.
    expect(left[0]).toBe("amexlens-2026-01-03T00-00-00-000Z.sqlite.age");
    expect(left.some((f) => !f.startsWith("amexlens-2026-01-0"))).toBe(true);
  }, 30_000);
});
