import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await getDB();
  return NextResponse.json({ currencies: await db.listCurrencies() });
}
