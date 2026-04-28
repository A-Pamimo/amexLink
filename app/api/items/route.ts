import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await getDB();
  const items = await db.listItems();
  // Don't leak access_tokens to the client.
  const safe = items.map(({ access_token, ...rest }) => rest);
  return NextResponse.json({ items: safe });
}
