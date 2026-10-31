import { audit } from "@/lib/audit";
import { assertCsrf } from "@/lib/auth/guard";
import { errorJson, jsonNoStore, readJsonObject } from "@/lib/auth/http";
import { checkLockout, recordFailure, recordSuccess } from "@/lib/auth/lockout";
import { consumeRecoveryCode } from "@/lib/auth/recovery";
import { issueSessionCookie } from "@/lib/auth/session";
import { getDB } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPE = "login";

export async function POST(req: Request) {
  const blocked = assertCsrf(req);
  if (blocked) return blocked;
  const locked = checkLockout(SCOPE);
  if (locked) return locked;

  const body = await readJsonObject(req);
  if (body instanceof Response) return body;
  const code = typeof body.code === "string" ? body.code : "";
  const consumed = await consumeRecoveryCode(code);
  if (!consumed) {
    recordFailure(SCOPE);
    await audit("auth.login", { outcome: "failure", detail: "recovery" });
    return errorJson(401, "invalid_code");
  }

  recordSuccess(SCOPE);
  const db = await getDB();
  const { remaining } = await db.countRecoveryCodes();
  await audit("auth.login", { outcome: "success", detail: `recovery:${remaining}_left` });
  const res = jsonNoStore({ ok: true, recovery_codes_remaining: remaining });
  await issueSessionCookie(req, res);
  return res;
}
