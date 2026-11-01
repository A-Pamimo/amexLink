import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";
import { intParam, strParam } from "@/lib/http/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp = url.searchParams;
  const months = intParam(sp, "months", { def: 6, min: 1, max: 24 });
  const item_id = strParam(sp, "item_id", { max: 128 });
  const include_non_spending = sp.get("include_non_spending") === "1";

  const db = await getDB();
  const trend = await db.monthlyTrend(months, item_id, include_non_spending);
  return NextResponse.json({ months, trend });
}
