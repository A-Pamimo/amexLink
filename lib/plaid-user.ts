import "server-only";
import { randomUUID } from "node:crypto";
import { getDB } from "./db";

const SETTING_KEY = "plaid_client_user_id";
const INFLIGHT = Symbol.for("amexlens.clientUserId.inflight");

/**
 * Per-install random `client_user_id` for Plaid (SECURITY.md P-I5, F-16). Generated on first use
 * and stored in `settings`; not an email, not a name, not derived from anything about the owner.
 * Concurrent first calls share one generation so two ids can never be minted.
 */
export async function getOrCreateClientUserId(): Promise<string> {
  const g = globalThis as unknown as Record<symbol, Promise<string> | undefined>;
  const running = g[INFLIGHT];
  if (running) return running;

  const p = (async () => {
    const db = await getDB();
    const existing = await db.getSetting(SETTING_KEY);
    if (existing) return existing;
    const id = randomUUID();
    await db.setSetting(SETTING_KEY, id);
    return id;
  })();
  g[INFLIGHT] = p;
  try {
    return await p;
  } finally {
    if (g[INFLIGHT] === p) g[INFLIGHT] = undefined;
  }
}
