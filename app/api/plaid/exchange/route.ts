import { NextResponse } from "next/server";
import { requireMutation } from "@/lib/auth/guard";
import { rotateSessionOnResponse } from "@/lib/auth/session";
import { getDB } from "@/lib/db";
import { newId } from "@/lib/id";
import { getPlaid } from "@/lib/plaid";
import { syncItem } from "@/lib/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;
  let body: {
    public_token?: string;
    institution?: { name?: string; id?: string } | null;
  } | null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const public_token: string | undefined = body?.public_token;
  const institution_name: string | null = body?.institution?.name ?? null;
  const institution_id: string | null = body?.institution?.id ?? null;

  if (!public_token) {
    return NextResponse.json({ error: "public_token required" }, { status: 400 });
  }

  const plaid = getPlaid();
  try {
    const exchange = await plaid.itemPublicTokenExchange({ public_token });
    const access_token = exchange.data.access_token;
    const item_id = exchange.data.item_id;

    const db = await getDB();
    const item = await db.insertItem({
      id: newId(),
      access_token,
      item_id,
      institution_name,
      institution_id,
    });

    const sync = await syncItem(item);
    const res = NextResponse.json({ item_id, sync });
    // Linking a card is a sensitive action: rotate the session token (SECURITY.md 3.3).
    await rotateSessionOnResponse(auth, res);
    return res;
  } catch (err) {
    const e = err as { response?: { data?: unknown }; message?: string };
    return NextResponse.json(
      { error: e?.response?.data ?? e?.message ?? "exchange failed" },
      { status: 500 }
    );
  }
}
