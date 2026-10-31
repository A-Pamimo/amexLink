import "server-only";
import { audit } from "../audit";
import { getDB } from "../db";
import { extractProviderError } from "../http/errors";
import { log } from "../log";
import { getPlaid } from "../plaid";
import { withItemLock } from "../sync/lock";

export type RevokeResult =
  | { ok: true }
  | { ok: false; code: string; provider_code?: string };

// Plaid says the item or token is already gone: nothing left to revoke remotely.
const ALREADY_DEAD = new Set(["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"]);

function isCredentialError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === "string" && /Decrypt|TokenUnreadable/i.test(name);
}

/**
 * Revoke at the provider FIRST, delete locally only after the provider accepts (or reports the
 * item already dead). On any other failure the row, its encrypted token and its transactions are
 * kept, the item is marked `revoke_failed`, and the caller can retry. Never logs or returns
 * tokens or provider text; only the Plaid error_code enum is surfaced.
 */
export async function revokeItem(id: string): Promise<RevokeResult> {
  const db = await getDB();
  const item = await db.getItemById(id);
  if (!item) return { ok: false, code: "item_not_found" };
  const item_id = item.item_id;

  // Serialise with any in-flight sync of the same item.
  return withItemLock(item_id, async (): Promise<RevokeResult> => {
    // A concurrent revoke may have finished while we waited for the lock.
    if (!(await db.getItemById(id))) return { ok: false, code: "item_not_found" };
    let outcome: "ok" | "already_removed";
    try {
      const secret = await db.getItemSecret(item_id);
      if (!secret) throw Object.assign(new Error("no credential"), { name: "TokenUnreadableError" });
      await getPlaid().itemRemove({ access_token: secret.access_token });
      outcome = "ok";
    } catch (err) {
      const info = extractProviderError(err);
      if (info.error_code && ALREADY_DEAD.has(info.error_code)) {
        outcome = "already_removed";
      } else {
        const provider_code =
          info.error_code ?? (isCredentialError(err) ? "CREDENTIAL_UNREADABLE" : "UNKNOWN");
        log.warn("revoke_failed", {
          item_id,
          error_code: info.error_code,
          error_type: info.error_type,
          request_id: info.request_id,
          status: info.status,
        });
        await db.setItemStatus(item_id, "revoke_failed", provider_code);
        await audit("revoke", { item_id, outcome: "revoke_failed", detail: provider_code });
        return { ok: false, code: "revoke_failed", provider_code };
      }
    }

    // Single DELETE; transactions go with it via ON DELETE CASCADE, atomically.
    await db.deleteItem(id);
    try {
      // Reclaim pages so deleted rows do not linger in the file.
      await db.vacuum();
    } catch {
      log.error("vacuum_failed", { item_id });
    }
    await audit("revoke", { item_id, outcome });
    return { ok: true };
  });
}
