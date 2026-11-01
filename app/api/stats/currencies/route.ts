import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getDB } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const db = await getDB();
  return NextResponse.json({ currencies: await db.listCurrencies() });
}
