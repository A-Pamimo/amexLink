import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";
import { defaultRange } from "@/lib/date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp = url.searchParams;
  const def = defaultRange();
  const from = sp.get("from") ?? def.from;
  const to = sp.get("to") ?? def.to;
  const item_id = sp.get("item_id") ?? undefined;
  const include_non_spending = sp.get("include_non_spending") === "1";

  const db = await getDB();
  const byBucket = await db.bucketTotals({
    from,
    to,
    item_id,
    include_non_spending,
  });
  const grandTotal = Object.values(byBucket).reduce(
    (sum, v) => sum + (v ?? 0),
    0
  );
  return NextResponse.json({ from, to, byBucket, grandTotal });
}
