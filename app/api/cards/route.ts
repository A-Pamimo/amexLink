import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getCardsResponse } from "@/lib/cards/view";
import { apiError } from "@/lib/http/errors";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only. Cards, per-field provenance, urgency and per-currency totals are derived at read
// time from stored provider observations; nothing in this response is client-writable.
export async function GET(req: Request) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json(await getCardsResponse());
  } catch {
    log.error("cards_view_failed", { route: "cards" });
    return apiError(500, "storage_error");
  }
}
