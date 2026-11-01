import { NextResponse } from "next/server";
import { getCardsResponse } from "@/lib/cards/view";
import { apiError } from "@/lib/http/errors";
import { logEvent } from "@/lib/http/log-shim";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// WP2: requireSession
// Read-only. Cards, per-field provenance, urgency and per-currency totals are derived at read
// time from stored provider observations; nothing in this response is client-writable.
export async function GET() {
  try {
    return NextResponse.json(await getCardsResponse());
  } catch {
    logEvent("cards_view_failed", { route: "cards" });
    return apiError(500, "storage_error");
  }
}
