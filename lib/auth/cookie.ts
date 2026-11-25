// Session cookie helpers. NO node imports: middleware.ts (edge runtime) and the
// handlers both import this file.

export const SESSION_TTL_SECONDS = 12 * 3600;

/**
 * `__Host-` requires Secure + Path=/ + no Domain (SECURITY.md 3.3). With
 * COOKIE_INSECURE_DEV=1 (plain-http LAN testing only, refused in production)
 * the prefix and the Secure flag are dropped so the browser accepts it.
 */
export function sessionCookieName(insecureDev: boolean): string {
  return insecureDev ? "amexlens_session" : "__Host-amexlens_session";
}

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

export function cookieOptions(insecureDev: boolean): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: !insecureDev,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes as base64url are exactly 43 chars. Anything else (e.g. `ok`) is not a token. */
export function looksLikeSessionToken(value: string | undefined | null): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

/**
 * Native-app (bearer) sessions. The mobile app sends `X-AmexLens-Client: mobile` on sign-in and
 * gets its token back in the `X-AmexLens-Session-Token` response header instead of a cookie; it
 * then presents `Authorization: Bearer <token>` on every API call.
 */
export const MOBILE_CLIENT_HEADER = "X-AmexLens-Client";
export const MOBILE_CLIENT_VALUE = "mobile";
export const SESSION_TOKEN_HEADER = "X-AmexLens-Session-Token";
export const SESSION_EXPIRES_HEADER = "X-AmexLens-Session-Expires";

const BEARER_RE = /^Bearer\s+(\S+)$/i;

/**
 * What the `Authorization` header holds: absent, a session-token-shaped bearer, or anything
 * else (malformed, wrong scheme, a non-session secret such as CRON_SECRET).
 */
export function parseAuthorization(
  header: string | null
): { kind: "absent" } | { kind: "session"; token: string } | { kind: "other" } {
  if (header === null) return { kind: "absent" };
  const presented = BEARER_RE.exec(header.trim())?.[1];
  return looksLikeSessionToken(presented) ? { kind: "session", token: presented } : { kind: "other" };
}

/** True when the caller identifies as the native app (exact header value). */
export function isMobileClient(headers: Headers): boolean {
  return headers.get(MOBILE_CLIENT_HEADER) === MOBILE_CLIENT_VALUE;
}

/** Serialise a Set-Cookie header value for the session cookie. */
export function serializeSessionCookie(
  name: string,
  value: string,
  opts: SessionCookieOptions,
  maxAgeOverride?: number
): string {
  const parts = [`${name}=${value}`, `Path=${opts.path}`, `Max-Age=${maxAgeOverride ?? opts.maxAge}`];
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Read one cookie value from a raw `Cookie` header without any framework helper. */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}
