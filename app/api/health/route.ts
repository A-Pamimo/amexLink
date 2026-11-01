import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public liveness probe: nothing but ok / not ok. Detail lives in /api/system (behind the session).
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const db = await getDB();
    if (await db.ping()) return NextResponse.json({ ok: true }, { headers });
  } catch {
    // fall through
  }
  return NextResponse.json({ ok: false }, { status: 503, headers });
}
