import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { getDB } from "@/lib/db";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { syncAllItems, syncItem } from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (!csrf.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Plaid syncs hit a paid upstream; cap to 30/min/IP.
  const limit = rateLimit(clientKey(req, "plaid:sync"), 30, 60 * 1000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate limited" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } }
    );
  }

  const url = new URL(req.url);
  const itemIdParam = url.searchParams.get("item_id");
  const db = await getDB();
  try {
    if (itemIdParam) {
      const item = await db.getItemByItemId(itemIdParam);
      if (!item) {
        return NextResponse.json({ error: "item not found" }, { status: 404 });
      }
      const result = await syncItem(item);
      return NextResponse.json(result);
    }
    const result = await syncAllItems();
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.response?.data ?? err?.message ?? "sync failed" },
      { status: 500 }
    );
  }
}
