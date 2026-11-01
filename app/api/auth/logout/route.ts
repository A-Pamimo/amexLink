import { audit } from "@/lib/audit";
import { assertCsrf } from "@/lib/auth/guard";
import { jsonNoStore } from "@/lib/auth/http";
import {
  clearSessionCookie,
  destroySession,
  sessionTokenFromRequest,
} from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deletes the session row (so every copy of the cookie dies) and clears the cookie. */
export async function POST(req: Request) {
  const blocked = assertCsrf(req);
  if (blocked) return blocked;
  const raw = sessionTokenFromRequest(req);
  if (raw) {
    await destroySession(raw);
    await audit("auth.logout", { outcome: "ok" });
  }
  const res = jsonNoStore({ ok: true });
  clearSessionCookie(res);
  return res;
}
