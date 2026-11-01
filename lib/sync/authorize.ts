import "server-only";
import { constantTimeEqual } from "../crypto";
import { env } from "../env";
import { apiError } from "../http/errors";

export type SyncAuthz =
  | { ok: true; via: "cron" | "session-pending" }
  | { ok: false; response: Response };

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Who may call POST /api/plaid/sync.
 *
 * - `Authorization: Bearer <CRON_SECRET>`: header ONLY (a secret in a query string lands in
 *   access logs and history, so it is ignored), compared in constant time, and only when
 *   CRON_SECRET is configured (>= 32 chars, enforced in lib/env.ts). A presented bearer is
 *   always validated strictly; a wrong or unconfigured one is 401, never a fall-through.
 * - No bearer: handled by the browser-session branch below.
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

  // WP2: also accept a valid browser session here. Replace the line below with
  //   const s = await requireSession(req); return s.ok ? { ok: true, via: "session" } : { ok: false, response: s.response };
  // (and requireMutation for the Origin / custom-header CSRF checks). Until the session concept
  // exists this keeps today's open behaviour for AUTH_MODE=none.
  return { ok: true, via: "session-pending" };
}
