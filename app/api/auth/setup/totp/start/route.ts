import QRCode from "qrcode";
import { audit } from "@/lib/audit";
import { authorizeSetup } from "@/lib/auth/factors";
import { errorJson, jsonNoStore, readJsonObject } from "@/lib/auth/http";
import { TOTP_AAD, base32Encode, generateTotpSecret, otpauthUri } from "@/lib/auth/totp";
import { encrypt } from "@/lib/crypto";
import { getDB } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start TOTP enrolment: store a fresh secret (encrypted, unconfirmed) and
 * return the otpauth URI plus a QR data URL. The secret becomes a factor only
 * after /confirm proves the authenticator has it.
 */
export async function POST(req: Request) {
  const body = await readJsonObject(req);
  if (body instanceof Response) return body;
  const gate = await authorizeSetup(req, body);
  if (!gate.ok) return gate.response;

  const db = await getDB();
  const state = await db.getAuthState();
  if (state?.totp_confirmed_at) return errorJson(409, "totp_enrolled");

  const secret = generateTotpSecret();
  await db.upsertAuthState({
    totp_secret_ct: encrypt(base32Encode(secret), TOTP_AAD),
    totp_confirmed_at: null,
    totp_last_step: null,
  });

  const account = env.APP_ORIGIN ? new URL(env.APP_ORIGIN).host : "owner";
  const otpauth_uri = otpauthUri({ secret, issuer: "AmexLens", account });
  const qr_data_url = await QRCode.toDataURL(otpauth_uri, { margin: 1, width: 220 });
  await audit("auth.setup.totp_start", { outcome: "ok" });
  return jsonNoStore({ otpauth_uri, qr_data_url });
}
