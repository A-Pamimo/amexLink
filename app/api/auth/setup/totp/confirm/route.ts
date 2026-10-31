import { audit } from "@/lib/audit";
import { SETUP_LOCKOUT_SCOPE, authorizeSetup } from "@/lib/auth/factors";
import { errorJson, jsonNoStore, readJsonObject } from "@/lib/auth/http";
import { recordFailure } from "@/lib/auth/lockout";
import { generateRecoveryCodes } from "@/lib/auth/recovery";
import { issueSessionCookie } from "@/lib/auth/session";
import { TOTP_AAD, base32Decode, verifyTotp } from "@/lib/auth/totp";
import { decrypt } from "@/lib/crypto";
import { getDB } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Confirm TOTP enrolment with a live code. On success: mark confirmed, mint the
 * recovery codes (returned exactly once) and sign the caller in.
 */
export async function POST(req: Request) {
  const body = await readJsonObject(req);
  if (body instanceof Response) return body;
  const gate = await authorizeSetup(req, body);
  if (!gate.ok) return gate.response;

  const db = await getDB();
  const state = await db.getAuthState();
  if (!state?.totp_secret_ct) return errorJson(400, "totp_not_started");
  if (state.totp_confirmed_at) return errorJson(409, "totp_enrolled");

  const secret = base32Decode(decrypt(state.totp_secret_ct, TOTP_AAD));
  const code = typeof body.code === "string" ? body.code : "";
  const result = verifyTotp(secret, code, { lastStep: null });
  if (!result.ok) {
    recordFailure(SETUP_LOCKOUT_SCOPE);
    await audit("auth.setup.totp_confirm", { outcome: "invalid_code" });
    return errorJson(401, "invalid_code");
  }

  await db.upsertAuthState({
    totp_confirmed_at: new Date().toISOString(),
    totp_last_step: result.step,
  });
  const recovery_codes = await generateRecoveryCodes();
  await audit("auth.setup.totp_confirm", { outcome: "ok" });

  const res = jsonNoStore({ ok: true, recovery_codes });
  await issueSessionCookie(req, res);
  return res;
}
