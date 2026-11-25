import { audit } from "@/lib/audit";
import { assertCsrf } from "@/lib/auth/guard";
import { jsonNoStore } from "@/lib/auth/http";
import {
  bearerTokenFromRequest,
  clearSessionCookie,
  destroySession,
  sessionTokenFromRequest,
} from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deletes the session row (so every copy of the token dies) and clears the cookie.
 * The native app presents its bearer token; a bearer needs no CSRF check (lib/auth/guard.ts).
 */
export async function POST(req: Request) {
  const bearer = bearerTokenFromRequest(req);
  if (!bearer) {
    const blocked = assertCsrf(req);
    if (blocked) return blocked;
  }
  const raw = bearer ?? sessionTokenFromRequest(req);
  if (raw) {
    await destroySession(raw);
    await audit("auth.logout", { outcome: "ok" });
  }
  const res = jsonNoStore({ ok: true });
  if (!bearer) clearSessionCookie(res);
  return res;
}
