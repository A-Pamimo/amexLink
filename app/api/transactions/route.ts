import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";
import { ALL_BUCKETS, type BucketKey, type TransactionFilters } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp = url.searchParams;
  const bucket = sp.get("bucket");
  const filters: TransactionFilters = {
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    bucket: bucket && ALL_BUCKETS.includes(bucket as BucketKey)
      ? (bucket as BucketKey)
      : undefined,
    item_id: sp.get("item_id") ?? undefined,
    q: sp.get("q") ?? undefined,
    limit: sp.get("limit") ? parseInt(sp.get("limit")!, 10) : 200,
    offset: sp.get("offset") ? parseInt(sp.get("offset")!, 10) : 0,
    include_non_spending: sp.get("include_non_spending") === "1",
  };

  const db = await getDB();
  const rows = await db.listTransactions(filters);
  return NextResponse.json({ transactions: rows });
}
