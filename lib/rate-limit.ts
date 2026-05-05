import "server-only";

interface Bucket {
  count: number;
  resetAt: number;
}

// Single-process, in-memory token bucket. Fine for a self-hosted single-instance
// deployment. If you ever scale horizontally, swap this for Redis/Upstash.
const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSec: 0 };
  }
  if (existing.count >= limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  existing.count += 1;
  return { ok: true, remaining: limit - existing.count, retryAfterSec: 0 };
}

export function clientKey(req: Request, scope: string): string {
  // x-forwarded-for is set by Caddy/Vercel; fall back to a fixed string when
  // running on plain localhost so devs aren't ratelimited per-tab.
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const ip = xff.split(",")[0]?.trim() || "local";
  return `${scope}:${ip}`;
}
