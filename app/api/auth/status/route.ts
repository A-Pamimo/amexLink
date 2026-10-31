import { factorStatus, noFactors } from "@/lib/auth/factors";
import { jsonNoStore } from "@/lib/auth/http";
import { authMode } from "@/lib/auth/mode";
import { requireSession } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unauthenticated: which factors exist, nothing secret. Drives the login page.
 * `recovery_codes_remaining` is only revealed to a valid session (red-team RT-05): an anonymous
 * scanner has no business knowing how many recovery codes the owner has left.
 */
export async function GET(req: Request) {
  const factors = await factorStatus();
  const signedIn = (await requireSession(req)).ok;
  return jsonNoStore({
    mode: authMode(),
    setup_required: noFactors(factors),
    factors: {
      totp: factors.totp,
      passkeys: factors.passkeys,
      recovery_codes_remaining: signedIn ? factors.recovery_codes_remaining : null,
    },
  });
}
