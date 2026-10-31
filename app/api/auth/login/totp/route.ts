import { audit } from "@/lib/audit";
import { assertCsrf } from "@/lib/auth/guard";
import { errorJson, jsonNoStore, readJsonObject } from "@/lib/auth/http";
import { checkLockout, recordFailure, recordSuccess } from "@/lib/auth/lockout";
import { issueSessionCookie } from "@/lib/auth/session";
import { TOTP_AAD, base32Decode, verifyTotp } from "@/lib/auth/totp";
import { decrypt } from "@/lib/crypto";
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
  const code = typeof body.code === "string" ? body.code : "";

  const db = await getDB();
  const state = await db.getAuthState();
  let step: number | null = null;
  if (state?.totp_secret_ct && state.totp_confirmed_at) {
    const secret = base32Decode(decrypt(state.totp_secret_ct, TOTP_AAD));
    const result = verifyTotp(secret, code, { lastStep: state.totp_last_step });
    if (result.ok) step = result.step;
  }

  if (step === null) {
    recordFailure(SCOPE);
    await audit("auth.login", { outcome: "failure", detail: "totp" });
    return errorJson(401, "invalid_code");
  }

  await db.upsertAuthState({ totp_last_step: step });
  recordSuccess(SCOPE);
  await audit("auth.login", { outcome: "success", detail: "totp" });
  const res = jsonNoStore({ ok: true });
  await issueSessionCookie(req, res);
  return res;
}
