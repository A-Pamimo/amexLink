import { errorJson } from "./http";

/**
 * Login lockout (SECURITY.md 3.3 "Rate limits", C-D2): 5 failures in 15
 * minutes locks the scope for 15 minutes with a 429 + Retry-After.
 *
 * Keyed by scope ONLY, not by client address: X-Forwarded-For is attacker
 * controlled and there is exactly one legitimate user, so a global counter is
 * both simpler and stricter. Residual risk, documented in the PR: the counter is
 * in-process and resets when the server restarts.
 */

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

interface Bucket {
  failures: number[];
  lockedUntil: number;
}

const buckets = new Map<string, Bucket>();

function bucket(scope: string): Bucket {
  let b = buckets.get(scope);
  if (!b) {
    b = { failures: [], lockedUntil: 0 };
    buckets.set(scope, b);
  }
  return b;
}

/** 429 response while the scope is locked, else null. */
export function checkLockout(scope: string, now: number = Date.now()): Response | null {
  const b = buckets.get(scope);
  if (!b) return null;
  if (b.lockedUntil > now) {
    const retry = Math.max(1, Math.ceil((b.lockedUntil - now) / 1000));
    return errorJson(429, "locked_out", { "retry-after": String(retry) });
  }
  if (b.lockedUntil !== 0) {
    // Lock expired: start clean.
    buckets.delete(scope);
  }
  return null;
}

export function recordFailure(scope: string, now: number = Date.now()): void {
  const b = bucket(scope);
  b.failures = b.failures.filter((t) => now - t < LOCKOUT_WINDOW_MS);
  b.failures.push(now);
  if (b.failures.length >= LOCKOUT_MAX_FAILURES) {
    b.lockedUntil = now + LOCKOUT_DURATION_MS;
    b.failures = [];
  }
}

export function recordSuccess(scope: string): void {
  buckets.delete(scope);
}

/** Test hook. */
export function resetLockouts(): void {
  buckets.clear();
}
