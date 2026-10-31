import "server-only";
import { log } from "../log";
import { apiError } from "./errors";

/**
 * In-process sliding-window limiter.
 *
 * Keyed by SCOPE ONLY (e.g. "link-token", "sync:<item_id>"), never by client IP or
 * X-Forwarded-For: AmexLens has exactly one user, so an attacker-supplied header must not be
 * able to mint fresh buckets, and legitimate traffic arrives from one place anyway. This is
 * correct while there is one Node process and one SQLite file (SECURITY.md 3.3); a
 * multi-process deploy would need a shared store.
 *
 * State lives on globalThis because Next may bundle the same module into several route
 * entries; module-level state would then give each route its own counters.
 */

const KEY = Symbol.for("amexlens.rateLimit");
type Store = Map<string, number[]>;

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  return (g[KEY] ??= new Map());
}

export const HOUR_MS = 60 * 60 * 1000;

export function rateLimit(
  scope: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const hits = (store().get(scope) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    store().set(scope, hits);
    const retryAfterSec = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
    return { ok: false, retryAfterSec };
  }
  hits.push(now);
  store().set(scope, hits);
  return { ok: true, retryAfterSec: 0 };
}

/** Returns a 429 response (with Retry-After) when over the limit, otherwise null. */
export function rateLimited(scope: string, limit: number, windowMs: number): Response | null {
  const r = rateLimit(scope, limit, windowMs);
  if (r.ok) return null;
  // SECURITY.md 3.6: rate-limit trips are a security event. Scope only; no caller data.
  log.info("rate_limited", { scope, retry_after_s: r.retryAfterSec });
  return apiError(429, "rate_limited", undefined, {
    headers: { "Retry-After": String(r.retryAfterSec) },
  });
}

export function resetRateLimits(): void {
  store().clear();
}
