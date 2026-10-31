import "server-only";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import { randomToken } from "../crypto";
import { getDB } from "../db";
import { env } from "../env";

/**
 * WebAuthn via @simplewebauthn/server v14 (SECURITY.md 3.3 "Passkey").
 *  - RP ID is the exact APP_ORIGIN host; expected origin is APP_ORIGIN.
 *  - User verification required on registration and assertion.
 *  - Challenges live server-side, single use, 5-minute TTL.
 *  - Signature counter must increase (regression → reject).
 * Failure reasons are short codes for the audit log; clients only ever see
 * `invalid_code` / `passkey_rejected`.
 */

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const RP_NAME = "AmexLens";

export function rpConfig(): { rpID: string; origin: string; rpName: string } {
  const origin = env.APP_ORIGIN;
  if (!origin) throw new Error("APP_ORIGIN is required for passkeys");
  return { rpID: new URL(origin).hostname, origin, rpName: RP_NAME };
}

async function userHandle(): Promise<Uint8Array<ArrayBuffer>> {
  const db = await getDB();
  const state = await db.getAuthState();
  if (state?.webauthn_user_id) {
    return Uint8Array.from(Buffer.from(state.webauthn_user_id, "base64url"));
  }
  const fresh = randomBytes(32);
  await db.upsertAuthState({ webauthn_user_id: fresh.toString("base64url") });
  return Uint8Array.from(fresh);
}

async function storeChallenge(kind: "reg" | "auth", challenge: string, now: number): Promise<string> {
  const db = await getDB();
  const id = randomToken(16);
  await db.createChallenge({
    id,
    kind,
    challenge,
    expires_at: new Date(now + CHALLENGE_TTL_MS).toISOString(),
  });
  await db.purgeChallenges(new Date(now).toISOString());
  return id;
}

export interface RegistrationStart {
  challenge_id: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}

export async function beginRegistration(now: number = Date.now()): Promise<RegistrationStart> {
  const { rpID, rpName } = rpConfig();
  const db = await getDB();
  const existing = await db.listPasskeys();
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: "owner",
    userDisplayName: "AmexLens owner",
    userID: await userHandle(),
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ?? undefined })),
  });
  const challenge_id = await storeChallenge("reg", options.challenge, now);
  return { challenge_id, options };
}

export type PasskeyOutcome = { ok: true; id: string } | { ok: false; reason: string };

export async function finishRegistration(args: {
  challenge_id: unknown;
  response: unknown;
  label?: unknown;
  now?: number;
}): Promise<PasskeyOutcome> {
  const now = args.now ?? Date.now();
  if (typeof args.challenge_id !== "string" || !args.response || typeof args.response !== "object") {
    return { ok: false, reason: "bad_request" };
  }
  const db = await getDB();
  const expectedChallenge = await db.consumeChallenge(
    args.challenge_id,
    "reg",
    new Date(now).toISOString()
  );
  if (!expectedChallenge) return { ok: false, reason: "challenge" };

  const { rpID, origin } = rpConfig();
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: args.response as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, reason: "verification_failed" };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, reason: "verification_failed" };
  }
  const info = verification.registrationInfo;
  const cred = info.credential;
  if (await db.getPasskey(cred.id)) return { ok: false, reason: "duplicate" };
  const label =
    typeof args.label === "string" && args.label.trim() !== ""
      ? args.label.trim().slice(0, 64)
      : null;
  await db.insertPasskey({
    id: cred.id,
    public_key: Buffer.from(cred.publicKey),
    counter: cred.counter,
    transports: cred.transports ?? null,
    device_type: info.credentialDeviceType ?? null,
    backed_up: typeof info.credentialBackedUp === "boolean" ? info.credentialBackedUp : null,
    label,
  });
  return { ok: true, id: cred.id };
}

export interface AuthenticationStart {
  challenge_id: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

export async function beginAuthentication(now: number = Date.now()): Promise<AuthenticationStart> {
  const { rpID } = rpConfig();
  const db = await getDB();
  const existing = await db.listPasskeys();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ?? undefined })),
  });
  const challenge_id = await storeChallenge("auth", options.challenge, now);
  return { challenge_id, options };
}

export async function finishAuthentication(args: {
  challenge_id: unknown;
  response: unknown;
  now?: number;
}): Promise<PasskeyOutcome> {
  const now = args.now ?? Date.now();
  if (typeof args.challenge_id !== "string" || !args.response || typeof args.response !== "object") {
    return { ok: false, reason: "bad_request" };
  }
  const response = args.response as AuthenticationResponseJSON;
  if (typeof response.id !== "string") return { ok: false, reason: "bad_request" };

  const db = await getDB();
  const expectedChallenge = await db.consumeChallenge(
    args.challenge_id,
    "auth",
    new Date(now).toISOString()
  );
  if (!expectedChallenge) return { ok: false, reason: "challenge" };

  const stored = await db.getPasskey(response.id);
  if (!stored) return { ok: false, reason: "unknown_credential" };

  const { rpID, origin } = rpConfig();
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(stored.public_key),
        counter: stored.counter,
        transports: stored.transports ?? undefined,
      },
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, reason: "verification_failed" };
  }
  if (!verification.verified) return { ok: false, reason: "verification_failed" };

  const newCounter = verification.authenticationInfo.newCounter;
  // Authenticators without a counter report 0 forever; anything else must increase.
  if ((stored.counter > 0 || newCounter > 0) && newCounter <= stored.counter) {
    return { ok: false, reason: "counter_regression" };
  }
  await db.updatePasskeyCounter(stored.id, newCounter, new Date(now).toISOString());
  return { ok: true, id: stored.id };
}
