import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

let currentDir: string | null = null;
let savedEnv: Record<string, string | undefined> = {};

/**
 * Boot a fresh app instance against a temp SQLite *file* (not :memory:, so WAL,
 * file modes and migrations behave like production).
 *
 * - resets the module registry, so `@/lib/env`, `@/lib/db` and anything imported
 *   afterwards re-read process.env and open a new database;
 * - sets DB_PATH (plus any `env` overrides) before importing;
 * - returns the opened DB and the temp dir.
 *
 * Import modules under test AFTER calling loadApp, via `await import(...)`.
 * Call closeApp() in afterEach.
 */
export async function loadApp(env: Record<string, string> = {}) {
  closeApp();
  vi.resetModules();

  currentDir = fs.mkdtempSync(path.join(os.tmpdir(), "amexlens-test-"));
  const overrides = { DB_PATH: path.join(currentDir, "test.sqlite"), ...env };
  savedEnv = {};
  for (const [k, v] of Object.entries(overrides)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  const { getDB } = await import("@/lib/db");
  const db = await getDB();
  return { db, dir: currentDir };
}

export function closeApp() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv = {};
  if (currentDir) {
    fs.rmSync(currentDir, { recursive: true, force: true });
    currentDir = null;
  }
}
