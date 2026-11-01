import { assertCsrf } from "@/lib/auth/guard";
import { jsonNoStore } from "@/lib/auth/http";
import { checkLockout } from "@/lib/auth/lockout";
import { beginAuthentication } from "@/lib/auth/passkey";
import { rateLimited } from "@/lib/http/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Assertion options (challenge stored server-side, 5-minute TTL, single use).
 * Unauthenticated by nature, so it is also rate limited (red-team RT-04): each call writes a
 * challenge row and returns the credential-id list, and nothing else bounded it.
 */
const OPTIONS_LIMIT = 30;
const OPTIONS_WINDOW_MS = 60_000;

export async function POST(req: Request) {
  const blocked = assertCsrf(req);
  if (blocked) return blocked;
  const locked = checkLockout("login");
  if (locked) return locked;
  const limited = rateLimited("passkey-options", OPTIONS_LIMIT, OPTIONS_WINDOW_MS);
  if (limited) return limited;
  const { challenge_id, options } = await beginAuthentication();
  return jsonNoStore({ challenge_id, options });
}
