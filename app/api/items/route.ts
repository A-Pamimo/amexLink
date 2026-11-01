import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await getDB();
  const items = await db.listItems();
  // Explicit allowlist: new fields must be added here on purpose.
  const safe = items.map((i) => ({
    id: i.id,
    item_id: i.item_id,
    institution_name: i.institution_name,
    institution_id: i.institution_id,
    created_at: i.created_at,
    last_synced_at: i.last_synced_at,
  }));
  return NextResponse.json({ items: safe });
}
