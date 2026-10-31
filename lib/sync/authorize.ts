import "server-only";
import { requireMutation } from "../auth/guard";
import { constantTimeEqual } from "../crypto";
import { env } from "../env";
import { apiError } from "../http/errors";

export type SyncAuthz =
  | { ok: true; via: "cron" | "session" }
  | { ok: false; response: Response };

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Who may call POST /api/plaid/sync.
 *
 * - `Authorization: Bearer <CRON_SECRET>`: header ONLY (a secret in a query string lands in
 *   access logs and history, so it is ignored), compared in constant time, and only when
 *   CRON_SECRET is configured (>= 32 chars, enforced in lib/env.ts). A presented bearer is
 *   always validated strictly, in every AUTH_MODE; a wrong or unconfigured one is 401, never
 *   a fall-through to the session path.
 * - No bearer: a valid browser session plus the mutation CSRF checks (Origin / Referer must
 *   match APP_ORIGIN and `X-AmexLens-Request` must be present), i.e. `requireMutation`.
 *   Under AUTH_MODE=none that stand-in always succeeds.
 *
 * Callers compose: `const authz = await authorizeSync(req); if (!authz.ok) return authz.response;`
 */
export async function authorizeSync(req: Request): Promise<SyncAuthz> {
  const header = req.headers.get("authorization");
  if (header !== null) {
    const presented = BEARER.exec(header.trim())?.[1];
    const secret = env.CRON_SECRET;
    if (!presented || !secret || !constantTimeEqual(presented, secret)) {
      return { ok: false, response: apiError(401, "unauthenticated") };
    }
    return { ok: true, via: "cron" };
  }

  const session = await requireMutation(req);
  if (!session.ok) return { ok: false, response: session.response };
  return { ok: true, via: "session" };
}
