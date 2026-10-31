import { NextResponse } from "next/server";
import { requireMutation } from "@/lib/auth/guard";
import { getDB } from "@/lib/db";
import { syncAllItems, syncItem } from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // WP4 replaces this with authorizeSync(req): a valid CRON_SECRET bearer OR
  // (valid session + mutation guard). Until then the browser path is gated here.
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;
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
  } catch (err) {
    const e = err as { response?: { data?: unknown }; message?: string };
    return NextResponse.json(
      { error: e?.response?.data ?? e?.message ?? "sync failed" },
      { status: 500 }
    );
  }
}
