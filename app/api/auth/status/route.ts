import { factorStatus, noFactors } from "@/lib/auth/factors";
import { jsonNoStore } from "@/lib/auth/http";
import { authMode } from "@/lib/auth/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Unauthenticated: which factors exist, nothing secret. Drives the login page. */
export async function GET() {
  const factors = await factorStatus();
  return jsonNoStore({
    mode: authMode(),
    setup_required: noFactors(factors),
    factors,
  });
}
