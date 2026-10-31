import { assertCsrf } from "@/lib/auth/guard";
import { jsonNoStore } from "@/lib/auth/http";
import { checkLockout } from "@/lib/auth/lockout";
import { beginAuthentication } from "@/lib/auth/passkey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Assertion options (challenge stored server-side, 5-minute TTL, single use). */
export async function POST(req: Request) {
  const blocked = assertCsrf(req);
  if (blocked) return blocked;
  const locked = checkLockout("login");
  if (locked) return locked;
  const { challenge_id, options } = await beginAuthentication();
  return jsonNoStore({ challenge_id, options });
}
