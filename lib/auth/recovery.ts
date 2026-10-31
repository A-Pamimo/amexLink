import "server-only";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "../crypto";
import { getDB } from "../db";

/**
 * Recovery codes (SECURITY.md 3.3): 10 codes, shown once, stored as sha256 of
 * the normalised code, each single use. Format `xxxxx-xxxxx` over the lowercase
 * base32 alphabet (50 bits each).
 */

export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function randomCode(): string {
  const bytes = randomBytes(10);
  let s = "";
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Lowercase, strip separators and whitespace. "ABCDE-FGH23" and "abcdefgh23" are the same code. */
export function normalizeRecoveryCode(input: string): string {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z2-7]/g, "");
}

export function hashRecoveryCode(input: string): string {
  return sha256Hex(`recovery:${normalizeRecoveryCode(input)}`);
}

/** Generate a fresh set, replacing every previous code. Returns the plaintext codes exactly once. */
export async function generateRecoveryCodes(): Promise<string[]> {
  const codes: string[] = [];
  while (codes.length < RECOVERY_CODE_COUNT) {
    const c = randomCode();
    if (!codes.includes(c)) codes.push(c);
  }
  const db = await getDB();
  await db.replaceRecoveryCodes(codes.map(hashRecoveryCode));
  return codes;
}

/** True when the code was unused and is now consumed. */
export async function consumeRecoveryCode(code: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== 10) return false;
  const db = await getDB();
  return db.consumeRecoveryCode(hashRecoveryCode(normalized));
}
