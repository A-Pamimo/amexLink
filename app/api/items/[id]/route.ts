import { NextResponse } from "next/server";
import { requireMutation } from "@/lib/auth/guard";
import { rotateSessionOnResponse } from "@/lib/auth/session";
import { apiError } from "@/lib/http/errors";
import { revokeItem } from "@/lib/items/revoke";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const result = await revokeItem(id);
  if (result.ok) {
    const res = NextResponse.json({ ok: true });
    // Disconnect is a sensitive action: rotate the session token (SECURITY.md 3.3).
    await rotateSessionOnResponse(auth, res);
    return res;
  }
  if (result.code === "item_not_found") return apiError(404, "item_not_found");
  return apiError(
    502,
    result.code,
    result.provider_code ? { provider_code: result.provider_code } : undefined
  );
}
