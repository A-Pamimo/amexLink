import { audit } from "@/lib/audit";
import { requireMutation } from "@/lib/auth/guard";
import { jsonNoStore } from "@/lib/auth/http";
import { clearSessionCookie, destroyAllSessions } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Sign out everywhere": delete every session row, including the caller's. */
export async function DELETE(req: Request) {
  const auth = await requireMutation(req);
  if (!auth.ok) return auth.response;
  const deleted = await destroyAllSessions();
  await audit("auth.logout_all", { outcome: "ok", detail: String(deleted) });
  const res = jsonNoStore({ ok: true, deleted });
  clearSessionCookie(res);
  return res;
}
