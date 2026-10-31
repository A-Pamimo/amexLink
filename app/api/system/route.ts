import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getDB } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator detail that used to be public on /api/health (SECURITY.md F-08 / C-I3).
export async function GET(req: Request) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  let items_count = 0;
  let tx_count = 0;
  let db_ok = false;
  try {
    const db = await getDB();
    items_count = (await db.listItems()).length;
    tx_count = await db.countTransactions();
    db_ok = await db.ping();
  } catch {
    db_ok = false;
  }
  return NextResponse.json(
    {
      db_ok,
      storage: env.STORAGE,
      auth_mode: env.AUTH_MODE,
      plaid_env: env.PLAID_ENV,
      country_codes: env.PLAID_COUNTRY_CODES,
      items_count,
      tx_count,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
