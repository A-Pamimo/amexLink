import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";
import { ALL_BUCKETS, type BucketKey } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let body: { bucket?: BucketKey } | null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const bucket = body?.bucket;
  if (!bucket || !ALL_BUCKETS.includes(bucket)) {
    return NextResponse.json({ error: "invalid bucket" }, { status: 400 });
  }
  const { id } = await params;
  const db = await getDB();
  const updated = await db.patchTransactionBucket(id, bucket);
  if (!updated) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ transaction: updated });
}

// DELETE = clear override, recompute auto-bucket.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDB();
  const updated = await db.resetTransactionBucket(id);
  if (!updated) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ transaction: updated });
}
