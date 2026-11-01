import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getDB } from "@/lib/db";
import { CURRENCY_PARAM } from "@/lib/currency";
import { intParam, strParam } from "@/lib/http/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const sp = url.searchParams;
  const months = intParam(sp, "months", { def: 6, min: 1, max: 24 });
  const item_id = strParam(sp, "item_id", { max: 128 });
  const include_non_spending = sp.get("include_non_spending") === "1";
  const currency = strParam(sp, "currency", { max: 16 });
  if (currency !== undefined && !CURRENCY_PARAM.test(currency)) {
    return NextResponse.json({ error: "invalid currency" }, { status: 400 });
  }

  const db = await getDB();
  const { byCurrency, currencies } = await db.monthlyTrend(
    months,
    item_id,
    include_non_spending,
    currency
  );
  return NextResponse.json({ months, currencies, byCurrency });
}
