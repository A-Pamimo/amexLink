import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";
import { ALL_BUCKETS, type BucketKey } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const bucket = body?.bucket as BucketKey | undefined;
  if (!bucket || !ALL_BUCKETS.includes(bucket)) {
    return NextResponse.json({ error: "invalid bucket" }, { status: 400 });
  }
  const db = await getDB();
  const updated = await db.patchTransactionBucket(params.id, bucket);
  if (!updated) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ transaction: updated });
}

// DELETE = clear override, recompute auto-bucket.
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const db = await getDB();
  const updated = await db.resetTransactionBucket(params.id);
  if (!updated) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ transaction: updated });
}
