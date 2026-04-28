import { NextResponse } from "next/server";
import { getDB } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let items_count = 0;
  let tx_count = 0;
  let db_ok = false;
  try {
    const db = await getDB();
    const items = await db.listItems();
    items_count = items.length;
    tx_count = await db.countTransactions();
    db_ok = true;
  } catch {
    db_ok = false;
  }
  return NextResponse.json({
    db_ok,
    storage: env.STORAGE,
    auth_mode: env.AUTH_MODE,
    plaid_env: env.PLAID_ENV,
    country_codes: env.PLAID_COUNTRY_CODES,
    items_count,
    tx_count,
  });
}
