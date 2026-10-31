import "server-only";
import { env } from "./env";
import { loadDataKey } from "./crypto";

/**
 * Fail fast at server start (called from instrumentation.ts) instead of on the
 * first request. Later work packages add their boot refusals here.
 */
export function assertBootConfig(): void {
  // Importing ./env validates required vars and throws on invalid values.
  void env;

  // Files created by the app (SQLite DB, WAL, backups) default to owner-only.
  process.umask(0o077);

  // WP3: data key. Refuse to start without a valid 32-byte key; there is no
  // plaintext fallback for tokens (SECURITY.md 3.1 "fail closed").
  loadDataKey();
}
