import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";
import { defaultRange } from "@/lib/date";
import { CURRENCY_PARAM } from "@/lib/currency";
import { strParam } from "@/lib/http/params";
import type { BucketTotals } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp = url.searchParams;
  const def = defaultRange();
  const from = strParam(sp, "from", { max: 10 }) ?? def.from;
  const to = strParam(sp, "to", { max: 10 }) ?? def.to;
  const item_id = strParam(sp, "item_id", { max: 128 });
  const include_non_spending = sp.get("include_non_spending") === "1";
  const currency = strParam(sp, "currency", { max: 16 });
  if (currency !== undefined && !CURRENCY_PARAM.test(currency)) {
    return NextResponse.json({ error: "invalid currency" }, { status: 400 });
  }

  const db = await getDB();
  const totals = await db.bucketTotals({ from, to, item_id, include_non_spending });

  // Each currency is summed on its own; there is deliberately no combined figure.
  const byCurrency: Record<string, { byBucket: BucketTotals; grandTotal: number }> = {};
  for (const c of currency ? [currency] : totals.currencies) {
    const byBucket = totals.byCurrency[c] ?? {};
    byCurrency[c] = {
      byBucket,
      grandTotal: Object.values(byBucket).reduce((sum, v) => sum + (v ?? 0), 0),
    };
  }
  return NextResponse.json({ from, to, currencies: totals.currencies, byCurrency });
}
