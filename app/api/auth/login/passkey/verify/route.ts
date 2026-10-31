import { audit } from "@/lib/audit";
import { assertCsrf } from "@/lib/auth/guard";
import { errorJson, jsonNoStore, readJsonObject } from "@/lib/auth/http";
import { checkLockout, recordFailure, recordSuccess } from "@/lib/auth/lockout";
import { finishAuthentication } from "@/lib/auth/passkey";
import { issueSessionCookie } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPE = "login";

export async function POST(req: Request) {
  const blocked = assertCsrf(req);
  if (blocked) return blocked;
  const locked = checkLockout(SCOPE);
  if (locked) return locked;

  const body = await readJsonObject(req);
  const outcome = await finishAuthentication({
    challenge_id: body.challenge_id,
    response: body.response,
  });
  if (!outcome.ok) {
    recordFailure(SCOPE);
    await audit("auth.login", { outcome: "failure", detail: `passkey:${outcome.reason}` });
    return errorJson(401, "invalid_code");
  }

  recordSuccess(SCOPE);
  await audit("auth.login", { outcome: "success", detail: "passkey" });
  const res = jsonNoStore({ ok: true });
  await issueSessionCookie(req, res);
  return res;
}
