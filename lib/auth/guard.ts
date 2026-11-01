import "server-only";
import { env } from "../env";
import { REQUEST_HEADER } from "../client/api";
import { errorJson } from "./http";
import { authMode } from "./mode";
import { requireSession, type SessionResult } from "./session";

/**
 * CSRF defence for state-changing routes (SECURITY.md 3.3 "CSRF").
 *
 * SameSite=Lax on the cookie blocks the classic cross-site form POST. On top:
 *  1. `Origin` must equal APP_ORIGIN exactly (fallback: the origin of `Referer`
 *     when Origin is absent; neither present → 403);
 *  2. the custom header `X-AmexLens-Request` must be present (browsers do not
 *     attach it to simple cross-site requests).
 *
 * Both checks are skipped when AUTH_MODE=none so that other work packages'
 * route tests keep running without headers.
 */

function csrf(): Response {
  return errorJson(403, "csrf");
}

function requestOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (origin) return origin;
  const referer = req.headers.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/** 403 response when the request does not come from APP_ORIGIN, else null. */
export function assertSameOrigin(req: Request): Response | null {
  if (authMode() === "none") return null;
  const expected = env.APP_ORIGIN;
  if (!expected) return csrf();
  const got = requestOrigin(req);
  if (!got || got !== expected) return csrf();
  return null;
}

/** 403 response when the custom request header is missing, else null. */
export function assertRequestHeader(req: Request): Response | null {
  if (authMode() === "none") return null;
  return req.headers.has(REQUEST_HEADER) ? null : csrf();
}

/** Origin + custom header, for routes that have no session yet (login, setup). */
export function assertCsrf(req: Request): Response | null {
  return assertSameOrigin(req) ?? assertRequestHeader(req);
}

/** Session AND CSRF checks. First statement of every POST/PATCH/DELETE handler. */
export async function requireMutation(req: Request): Promise<SessionResult> {
  const auth = await requireSession(req);
  if (!auth.ok) return auth;
  const blocked = assertCsrf(req);
  if (blocked) return { ok: false, response: blocked };
  return auth;
}
