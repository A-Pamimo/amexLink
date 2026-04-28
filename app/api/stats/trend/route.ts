import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp = url.searchParams;
  const months = Math.max(1, Math.min(24, parseInt(sp.get("months") ?? "6", 10) || 6));
  const item_id = sp.get("item_id") ?? undefined;
  const include_non_spending = sp.get("include_non_spending") === "1";

  const db = await getDB();
  const trend = await db.monthlyTrend(months, item_id, include_non_spending);
  return NextResponse.json({ months, trend });
}
