import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";
import { syncAllItems, syncItem } from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
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
