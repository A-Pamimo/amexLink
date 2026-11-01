import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getDB } from "@/lib/db";
import { intParam, strParam } from "@/lib/http/params";
import { ALL_BUCKETS, type BucketKey, type TransactionFilters } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const sp = url.searchParams;
  const bucket = sp.get("bucket");
  const filters: TransactionFilters = {
    from: strParam(sp, "from", { max: 32 }),
    to: strParam(sp, "to", { max: 32 }),
    bucket: bucket && ALL_BUCKETS.includes(bucket as BucketKey)
      ? (bucket as BucketKey)
      : undefined,
    item_id: strParam(sp, "item_id", { max: 128 }),
    q: strParam(sp, "q", { max: 100 }),
    // intParam never yields NaN, so a junk `limit` cannot drop the LIMIT clause.
    limit: intParam(sp, "limit", { def: 200, min: 1, max: 1000 }),
    offset: intParam(sp, "offset", { def: 0, min: 0, max: 1_000_000 }),
    include_non_spending: sp.get("include_non_spending") === "1",
  };

  const db = await getDB();
  const rows = await db.listTransactions(filters);
  return NextResponse.json({ transactions: rows });
}
