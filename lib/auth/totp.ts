import { createHmac, randomBytes } from "node:crypto";
import { constantTimeEqual } from "../crypto";

/**
 * RFC 6238 TOTP over RFC 4226 HOTP, HMAC-SHA1, 30-second step, ±1 window,
 * replay rejection via the last accepted step (SECURITY.md 3.3 "TOTP").
 * Hand-rolled on node:crypto (plan decision: no otplib dependency tree).
 */

/** AAD bound into the encrypted TOTP secret in auth_state. */
export const TOTP_AAD = "auth_state:totp";
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const WINDOW = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, upper case, no padding. */
export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, "").replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 random bytes (160 bits), the RFC 4226 recommended secret size for SHA-1. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** HOTP(secret, step) with dynamic truncation (RFC 4226 §5.3). */
export function totpAt(secret: Buffer, step: number, digits: number = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  const code = bin % 10 ** digits;
  return String(code).padStart(digits, "0");
}

export interface VerifyTotpOptions {
  now?: number;
  /** Last accepted step; any code for this step or earlier is a replay. */
  lastStep?: number | null;
  digits?: number;
}

export type VerifyTotpResult = { ok: true; step: number } | { ok: false };

/**
 * Accepts the code for the current step or its neighbours (±1), rejects
 * anything at or before `lastStep`. Code comparison is constant time.
 */
export function verifyTotp(secret: Buffer, code: string, opts: VerifyTotpOptions = {}): VerifyTotpResult {
  const digits = opts.digits ?? TOTP_DIGITS;
  const normalized = String(code ?? "").replace(/\s+/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return { ok: false };
  const now = opts.now ?? Date.now();
  const current = stepAt(now);
  const lastStep = opts.lastStep ?? null;
  // Evaluate every candidate so timing does not reveal which window matched.
  let matched: number | null = null;
  for (let delta = -WINDOW; delta <= WINDOW; delta++) {
    const step = current + delta;
    const expected = totpAt(secret, step, digits);
    const equal = constantTimeEqual(expected, normalized);
    const replay = lastStep !== null && step <= lastStep;
    if (equal && !replay && matched === null) matched = step;
  }
  return matched === null ? { ok: false } : { ok: true, step: matched };
}

export function otpauthUri(params: { secret: Buffer; issuer: string; account: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const qs = new URLSearchParams({
    secret: base32Encode(params.secret),
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${qs.toString()}`;
}
