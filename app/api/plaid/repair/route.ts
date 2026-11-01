import { NextResponse } from "next/server";
import { requireMutation } from "@/lib/auth/guard";
import { rotateSessionOnResponse } from "@/lib/auth/session";
import { getDB } from "@/lib/db";
import { readJsonBody } from "@/lib/http/body";
import { apiError } from "@/lib/http/errors";
import { HOUR_MS, rateLimited } from "@/lib/http/rate-limit";
import { SyncError, syncItem } from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Completion step of the repair (update-mode, `access_token` only) Link flow. The access token
 * does not change, so there is nothing to exchange: clear the `needs_relink` flag and sync once.
 * If the credentials are still bad the sync flags the item again and the failure is reported
 * in `sync`; the repair itself is still acknowledged.
 */
export async function POST(req: Request) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const item_id = (body as { item_id?: unknown } | null)?.item_id;
  if (typeof item_id !== "string" || item_id === "" || item_id.length > 128) {
    return apiError(400, "item_id_required");
  }

  const db = await getDB();
  const item = await db.getItemByItemId(item_id);
  if (!item) return apiError(404, "item_not_found");
  // A half-revoked item must go through "Retry revoke", not come back to life.
  if (item.status === "revoke_failed") return apiError(409, "item_revoking");

  const limited = rateLimited(`repair:${item_id}`, 6, HOUR_MS);
  if (limited) return limited;

  await db.setItemStatus(item_id, "active", null);

  let sync: { ok: boolean; error_code?: string };
  try {
    await syncItem(item);
    sync = { ok: true };
  } catch (err) {
    sync = { ok: false, error_code: err instanceof SyncError ? err.code : "sync_failed" };
  }

  const res = NextResponse.json({ ok: true, sync });
  await rotateSessionOnResponse(auth, res);
  return res;
}
