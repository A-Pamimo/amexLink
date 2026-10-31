import { NextResponse } from "next/server";
import { requireMutation } from "@/lib/auth/guard";
import { rotateSessionOnResponse } from "@/lib/auth/session";
import { getDB } from "@/lib/db";
import { getPlaid } from "@/lib/plaid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const db = await getDB();
  const target = await db.getItemById(id);
  if (!target) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // TODO(WP4): revoke at Plaid first and keep the local token if itemRemove fails
  // (today we delete locally even on failure, orphaning a still-billed Item).
  try {
    const secret = await db.getItemSecret(target.item_id);
    if (secret) await getPlaid().itemRemove({ access_token: secret.access_token });
  } catch {
    // Best-effort: continue removing locally even if Plaid call fails.
  }
  await db.deleteItem(target.id);
  const res = NextResponse.json({ ok: true });
  // Disconnect is a sensitive action: rotate the session token (SECURITY.md 3.3).
  await rotateSessionOnResponse(auth, res);
  return res;
}
