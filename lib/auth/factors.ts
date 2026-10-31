import "server-only";
import { constantTimeEqual } from "../crypto";
import { getDB } from "../db";
import { env } from "../env";
import { assertCsrf, requireMutation } from "./guard";
import { errorJson } from "./http";
import { checkLockout, recordFailure, recordSuccess } from "./lockout";
import { authMode } from "./mode";

export interface FactorStatus {
  totp: boolean;
  passkeys: number;
  recovery_codes_remaining: number;
}

/** Enrolled factors. An unconfirmed TOTP secret does not count. */
export async function factorStatus(): Promise<FactorStatus> {
  const db = await getDB();
  const [state, passkeys, codes] = await Promise.all([
    db.getAuthState(),
    db.listPasskeys(),
    db.countRecoveryCodes(),
  ]);
  return {
    totp: Boolean(state?.totp_confirmed_at),
    passkeys: passkeys.length,
    recovery_codes_remaining: codes.remaining,
  };
}

export function noFactors(f: FactorStatus): boolean {
  return !f.totp && f.passkeys === 0;
}

export const SETUP_LOCKOUT_SCOPE = "setup";

export type SetupGate =
  | { ok: true; firstFactor: boolean }
  | { ok: false; response: Response };

/**
 * Who may enrol a factor:
 *  - while ZERO factors exist and AUTH_MODE=required: anyone presenting
 *    `setup_token` equal to AUTH_SETUP_TOKEN (constant time), from APP_ORIGIN
 *    with the custom header, subject to the lockout;
 *  - otherwise: a valid session plus the CSRF checks (`requireMutation`).
 * AUTH_SETUP_TOKEN is never consulted once a factor exists.
 */
export async function authorizeSetup(
  req: Request,
  body: Record<string, unknown>
): Promise<SetupGate> {
  const factors = await factorStatus();
  const bootstrap = noFactors(factors) && authMode() === "required";
  if (!bootstrap) {
    const m = await requireMutation(req);
    if (!m.ok) return m;
    return { ok: true, firstFactor: noFactors(factors) };
  }

  const blocked = assertCsrf(req);
  if (blocked) return { ok: false, response: blocked };
  const locked = checkLockout(SETUP_LOCKOUT_SCOPE);
  if (locked) return { ok: false, response: locked };

  const expected = env.AUTH_SETUP_TOKEN;
  const presented = body.setup_token;
  if (!expected || typeof presented !== "string" || !constantTimeEqual(presented, expected)) {
    recordFailure(SETUP_LOCKOUT_SCOPE);
    return { ok: false, response: errorJson(401, "invalid_setup_token") };
  }
  recordSuccess(SETUP_LOCKOUT_SCOPE);
  return { ok: true, firstFactor: true };
}
