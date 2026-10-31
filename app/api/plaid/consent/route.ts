import { NextResponse } from "next/server";
import { requireMutation } from "@/lib/auth/guard";
import { rotateSessionOnResponse } from "@/lib/auth/session";
import { refreshItemCards } from "@/lib/cards/refresh";
import { getDB } from "@/lib/db";
import { apiError } from "@/lib/http/errors";
import { HOUR_MS, rateLimited } from "@/lib/http/rate-limit";
import { withItemLock } from "@/lib/sync/lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Completion step of the consent (update-mode) Link flow. Link has already stored the new
 * consent at Plaid; here the app re-reads liabilities once (cached balances only, never the
 * billed call). `refreshItemCards` moves the item from `consent_required` to `active` when
 * Liabilities now answers.
 */
export async function POST(req: Request) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(400, "invalid_json");
  }
  const item_id = (body as { item_id?: unknown } | null)?.item_id;
  if (typeof item_id !== "string" || item_id === "" || item_id.length > 128) {
    return apiError(400, "item_id_required");
  }

  // Existence before the limiter, so random ids cannot mint rate-limit buckets.
  const db = await getDB();
  if (!(await db.getItemByItemId(item_id))) return apiError(404, "item_not_found");

  const limited = rateLimited(`consent:${item_id}`, 6, HOUR_MS);
  if (limited) return limited;

  const outcome = await withItemLock(item_id, () =>
    refreshItemCards(item_id, { realtimeBalance: false })
  );
  if (!outcome.ok) {
    return outcome.code === "item_not_found"
      ? apiError(404, "item_not_found")
      : outcome.code === "credential_unavailable"
        ? apiError(409, "credential_unavailable")
        : apiError(502, "provider_unavailable");
  }

  const item = await db.getItemByItemId(item_id);
  const res = NextResponse.json({
    ok: true,
    liabilities_status: outcome.liabilities_status,
    item_status: item?.status ?? null,
  });
  await rotateSessionOnResponse(auth, res);
  return res;
}
