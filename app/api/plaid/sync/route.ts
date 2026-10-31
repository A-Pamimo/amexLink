import { NextResponse } from "next/server";
import { getCardsResponse } from "@/lib/cards/view";
import { getDB } from "@/lib/db";
import { apiError, statusForCode } from "@/lib/http/errors";
import { HOUR_MS, rateLimited } from "@/lib/http/rate-limit";
import { strParam } from "@/lib/http/params";
import { authorizeSync } from "@/lib/sync/authorize";
import { SyncError, syncAllItems, syncItem } from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Interactive syncs: 6/h per item (SECURITY.md 3.3). The cron has its own, looser bucket so
// a manual click cannot starve it (and vice versa).
const MANUAL_LIMIT = 6;
const CRON_LIMIT = 12;

/** Urgency counts only (no amounts); omitted if the cards view cannot be built. */
async function cardCounts(): Promise<{ overdue: number; due_soon: number } | undefined> {
  try {
    return (await getCardsResponse()).counts;
  } catch {
    return undefined;
  }
}

export async function POST(req: Request) {
  const authz = await authorizeSync(req);
  if (!authz.ok) return authz.response;

  const sp = new URL(req.url).searchParams;
  const itemIdParam = strParam(sp, "item_id", { max: 128 });
  const scope = (itemIdParam ?? "all");
  const limited =
    authz.via === "cron"
      ? rateLimited(`sync-cron:${scope}`, CRON_LIMIT, HOUR_MS)
      : rateLimited(`sync:${scope}`, MANUAL_LIMIT, HOUR_MS);
  if (limited) return limited;

  const db = await getDB();
  if (itemIdParam) {
    const item = await db.getItemByItemId(itemIdParam);
    if (!item) return apiError(404, "item_not_found");
    try {
      const r = await syncItem(item);
      return NextResponse.json({
        items: [{ item_id: item.item_id, ok: true, ...r }],
        totals: r,
        cards: await cardCounts(),
      });
    } catch (err) {
      const code = err instanceof SyncError ? err.code : "sync_failed";
      return apiError(
        statusForCode(code),
        code,
        err instanceof SyncError && err.provider_code
          ? { provider_code: err.provider_code }
          : undefined
      );
    }
  }

  // Counts and codes only; a failing item is reported in `items`, not thrown.
  const all = await syncAllItems();
  return NextResponse.json({ ...all, cards: await cardCounts() });
}
