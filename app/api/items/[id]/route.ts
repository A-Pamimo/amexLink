import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";
import { getPlaid } from "@/lib/plaid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const db = await getDB();
  const items = await db.listItems();
  const target = items.find((i) => i.id === params.id);
  if (!target) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    await getPlaid().itemRemove({ access_token: target.access_token });
  } catch {
    // Best-effort: continue removing locally even if Plaid call fails.
  }
  await db.deleteItem(target.id);
  return NextResponse.json({ ok: true });
}
