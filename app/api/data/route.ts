import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { requireMutation } from "@/lib/auth/guard";
import { rotateSessionOnResponse } from "@/lib/auth/session";
import { getDB } from "@/lib/db";
import { apiError } from "@/lib/http/errors";
import { revokeItem } from "@/lib/items/revoke";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ItemResult {
  item_id: string;
  ok: boolean;
  code?: string;
}

/**
 * "Delete all local data" (SECURITY.md 3.11, privacy checklist).
 *
 * 1. Every item is revoked at the provider FIRST, sequentially, through revokeItem (the same
 *    revoke-then-delete path as disconnecting one card). An item whose revoke fails stays in
 *    place, marked `revoke_failed`, so it can be retried.
 * 2. If ANY revoke failed: 502 `revoke_incomplete` with the per-item results, and the wipe step
 *    below does not run. Items that did revoke are already gone, exactly as if they had been
 *    disconnected one by one: their remote connection no longer exists.
 * 3. Otherwise one transaction removes transactions, account_fields, accounts, plaid_items and
 *    the settings keys, then VACUUM. `security_log` is kept and gets a `data_delete_all` row.
 *
 * It does not claim Plaid deleted anything: Plaid retains data under its own policy.
 * Results carry our item_id and a short code only: no tokens, no provider text.
 */
export async function DELETE(req: Request) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;

  const db = await getDB();
  const items = await db.listItems();

  const results: ItemResult[] = [];
  for (const item of items) {
    const r = await revokeItem(item.id);
    if (r.ok) results.push({ item_id: item.item_id, ok: true });
    else results.push({ item_id: item.item_id, ok: false, code: r.provider_code ?? r.code });
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    await audit("data_delete_all", {
      outcome: "revoke_incomplete",
      detail: `${failed.length} of ${results.length} items not revoked`,
    });
    // Same `{ error: { code } }` shape as every API error, plus the per-item results beside it.
    return NextResponse.json({ error: { code: "revoke_incomplete" }, results }, { status: 502 });
  }

  try {
    const removed = await db.deleteAllCardData();
    try {
      await db.vacuum();
    } catch {
      log.error("vacuum_failed", { route: "data" });
    }
    await audit("data_delete_all", {
      outcome: "ok",
      detail: `items=${removed.items} accounts=${removed.accounts} transactions=${removed.transactions}`,
    });
  } catch {
    log.error("delete_all_failed", { route: "data" });
    return apiError(500, "storage_error");
  }

  const res = NextResponse.json({ ok: true, results });
  // Sensitive action: rotate the session token (SECURITY.md 3.3).
  await rotateSessionOnResponse(auth, res);
  return res;
}
