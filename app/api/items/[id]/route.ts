import { NextResponse } from "next/server";
import { apiError } from "@/lib/http/errors";
import { revokeItem } from "@/lib/items/revoke";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await revokeItem(id);
  if (result.ok) return NextResponse.json({ ok: true });
  if (result.code === "item_not_found") return apiError(404, "item_not_found");
  return apiError(
    502,
    result.code,
    result.provider_code ? { provider_code: result.provider_code } : undefined
  );
}
