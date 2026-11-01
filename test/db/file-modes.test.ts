import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { closeApp, loadApp } from "../helpers/app";

afterEach(() => closeApp());

const posix = process.platform !== "win32";

describe.skipIf(!posix)("sqlite file modes", () => {
  it("sets the DB directory to 0700 and the DB file (and WAL/SHM) to 0600 on open", async () => {
    const { dir, db } = await loadApp();
    const p = path.join(dir, "test.sqlite");
    await db.setSetting("k", "v"); // force a WAL write so -wal/-shm exist
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    for (const side of [`${p}-wal`, `${p}-shm`]) {
      if (fs.existsSync(side)) expect(fs.statSync(side).mode & 0o777).toBe(0o600);
    }
  });

  it("hardenFileModes repairs loosened modes without trusting umask", async () => {
    const { dir } = await loadApp();
    const { hardenFileModes } = await import("@/lib/db/sqlite");
    const p = path.join(dir, "test.sqlite");
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(p, 0o644);
    hardenFileModes(p);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });
});
