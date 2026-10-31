import { NextResponse } from "next/server";
import { requireMutation } from "@/lib/auth/guard";
import { getDB } from "@/lib/db";
import { readJsonBody } from "@/lib/http/body";
import { ALL_BUCKETS, type BucketKey } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { bucket?: BucketKey } | null | undefined;
  const bucket = body && typeof body === "object" ? body.bucket : undefined;
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
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const db = await getDB();
  const updated = await db.resetTransactionBucket(id);
  if (!updated) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ transaction: updated });
}
