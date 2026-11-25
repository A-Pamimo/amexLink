import "server-only";
import { randomToken, sha256Hex } from "../crypto";
import { getDB, type SessionKind, type SessionRow } from "../db";
import {
  cookieOptions,
  isMobileClient,
  parseAuthorization,
  readCookie,
  serializeSessionCookie,
  sessionCookieName,
  looksLikeSessionToken,
  SESSION_EXPIRES_HEADER,
  SESSION_TOKEN_HEADER,
  SESSION_TTL_SECONDS,
} from "./cookie";
import { authMode, cookieInsecureDev } from "./mode";
import { errorJson } from "./http";

/**
 * Server-side sessions (SECURITY.md 3.3 "Session", F-02, C-S1..C-S3).
 *
 * - raw token: 32 random bytes, base64url, lives only in the cookie (browser) or in the
 *   native app's secure storage (bearer);
 * - DB stores sha256(raw) as the row id, plus the session `kind`;
 * - cookie sessions: absolute lifetime 12 h, idle timeout 2 h;
 *   bearer sessions: absolute 30 days, idle 7 days (the app adds a biometric lock on top);
 * - `last_seen_at` touched at most once per minute;
 * - a token is accepted only on its own transport: a cookie token presented as a bearer (or
 *   the reverse) is 401, so each kind keeps its own lifetimes and CSRF rules;
 * - logout / rotate delete the row, so every other copy of the token dies.
 *
 * Nothing here logs or returns the raw token except to the Set-Cookie header or, for the
 * native app, the `X-AmexLens-Session-Token` response header.
 */

export const ABSOLUTE_TTL_MS = SESSION_TTL_SECONDS * 1000;
export const IDLE_TTL_MS = 2 * 3600 * 1000;
export const BEARER_ABSOLUTE_TTL_MS = 30 * 24 * 3600 * 1000;
export const BEARER_IDLE_TTL_MS = 7 * 24 * 3600 * 1000;
export const TOUCH_INTERVAL_MS = 60 * 1000;

const TTL: Record<SessionKind, { absolute: number; idle: number }> = {
  cookie: { absolute: ABSOLUTE_TTL_MS, idle: IDLE_TTL_MS },
  bearer: { absolute: BEARER_ABSOLUTE_TTL_MS, idle: BEARER_IDLE_TTL_MS },
};

export interface Session {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  /** How the token arrived. `none` is the AUTH_MODE=none stand-in. */
  transport: SessionKind | "none";
  /** True when AUTH_MODE=none produced a stand-in session (no row, no cookie). */
  synthetic: boolean;
}

export type SessionResult =
  | { ok: true; session: Session; /** raw token, for rotate/logout; never log it */ raw: string | null }
  | { ok: false; response: Response };

export function unauthenticated(): Response {
  return errorJson(401, "unauthenticated");
}

export function currentCookieName(): string {
  return sessionCookieName(cookieInsecureDev());
}

/** Raw session token from the request's Cookie header, or null. Does not validate it. */
export function sessionTokenFromRequest(req: Request): string | null {
  const v = readCookie(req.headers.get("cookie"), currentCookieName());
  return looksLikeSessionToken(v) ? v : null;
}

/** Raw session token from `Authorization: Bearer`, or null. Does not validate it. */
export function bearerTokenFromRequest(req: Request): string | null {
  const a = parseAuthorization(req.headers.get("authorization"));
  return a.kind === "session" ? a.token : null;
}

/** Create a session row and return the raw token to hand to the client. */
export async function createSession(
  now: number = Date.now(),
  kind: SessionKind = "cookie"
): Promise<string> {
  const raw = randomToken(32);
  const db = await getDB();
  const iso = new Date(now).toISOString();
  await db.createSession({
    id: sha256Hex(raw),
    created_at: iso,
    last_seen_at: iso,
    expires_at: new Date(now + TTL[kind].absolute).toISOString(),
    kind,
  });
  // Opportunistic housekeeping; cheap on a single-user DB.
  await db.purgeExpiredSessions(iso);
  return raw;
}

function liveSession(row: SessionRow, now: number): boolean {
  const expires = Date.parse(row.expires_at);
  const lastSeen = Date.parse(row.last_seen_at);
  if (!Number.isFinite(expires) || !Number.isFinite(lastSeen)) return false;
  if (now >= expires) return false;
  if (now - lastSeen > TTL[row.kind].idle) return false;
  return true;
}

/**
 * Look up the session named by the request. If an `Authorization` header is present, it is
 * the only credential considered (a bearer session; the cookie is ignored and anything that is
 * not a session-shaped bearer is 401). Otherwise the cookie. On success, touches `last_seen_at`
 * (at most once per TOUCH_INTERVAL_MS). Expired or idle rows are deleted.
 */
export async function requireSession(
  req: Request,
  opts: { now?: number } = {}
): Promise<SessionResult> {
  const now = opts.now ?? Date.now();
  if (authMode() === "none") {
    const iso = new Date(now).toISOString();
    return {
      ok: true,
      raw: null,
      session: {
        id: "none",
        created_at: iso,
        last_seen_at: iso,
        expires_at: new Date(now + ABSOLUTE_TTL_MS).toISOString(),
        transport: "none",
        synthetic: true,
      },
    };
  }

  const auth = parseAuthorization(req.headers.get("authorization"));
  if (auth.kind === "other") return { ok: false, response: unauthenticated() };
  const transport: SessionKind = auth.kind === "session" ? "bearer" : "cookie";
  const raw = auth.kind === "session" ? auth.token : sessionTokenFromRequest(req);
  if (!raw) return { ok: false, response: unauthenticated() };

  const db = await getDB();
  const id = sha256Hex(raw);
  const row = await db.getSession(id);
  if (!row) return { ok: false, response: unauthenticated() };
  // Wrong transport: refuse without deleting, the token is still valid where it belongs.
  if (row.kind !== transport) return { ok: false, response: unauthenticated() };
  if (!liveSession(row, now)) {
    await db.deleteSession(id);
    return { ok: false, response: unauthenticated() };
  }
  let last_seen_at = row.last_seen_at;
  if (now - Date.parse(row.last_seen_at) >= TOUCH_INTERVAL_MS) {
    last_seen_at = new Date(now).toISOString();
    await db.touchSession(id, last_seen_at);
  }
  return {
    ok: true,
    raw,
    session: {
      id: row.id,
      created_at: row.created_at,
      last_seen_at,
      expires_at: row.expires_at,
      transport,
      synthetic: false,
    },
  };
}

/** Issue a new token of the same kind and delete the old row (login, link, disconnect). */
export async function rotateSession(
  oldRaw: string | null,
  now: number = Date.now(),
  kind: SessionKind = "cookie"
): Promise<string> {
  const db = await getDB();
  const fresh = await createSession(now, kind);
  if (oldRaw) await db.deleteSession(sha256Hex(oldRaw));
  return fresh;
}

export async function destroySession(raw: string | null): Promise<void> {
  if (!raw) return;
  const db = await getDB();
  await db.deleteSession(sha256Hex(raw));
}

export async function destroyAllSessions(): Promise<number> {
  const db = await getDB();
  return db.deleteAllSessions();
}

export function setSessionCookie(res: Response, raw: string): void {
  const insecure = cookieInsecureDev();
  res.headers.append(
    "set-cookie",
    serializeSessionCookie(sessionCookieName(insecure), raw, cookieOptions(insecure))
  );
}

export function clearSessionCookie(res: Response): void {
  const insecure = cookieInsecureDev();
  res.headers.append(
    "set-cookie",
    serializeSessionCookie(sessionCookieName(insecure), "", cookieOptions(insecure), 0)
  );
}

/** Hand a bearer token to the native app. Every auth response is already `no-store`. */
export function setSessionTokenHeader(res: Response, raw: string, now: number = Date.now()): void {
  res.headers.set(SESSION_TOKEN_HEADER, raw);
  res.headers.set(SESSION_EXPIRES_HEADER, new Date(now + BEARER_ABSOLUTE_TTL_MS).toISOString());
  res.headers.set("cache-control", "no-store");
}

/**
 * Login / first-factor enrolment success: mint a session and put it on `res`.
 * - native app (`X-AmexLens-Client: mobile`): a bearer session in the response header, rotating
 *   any bearer the app already presented; no cookie is set;
 * - browser: a cookie session, rotating any cookie the browser already presented.
 */
export async function issueSessionCookie(req: Request, res: Response): Promise<void> {
  if (isMobileClient(req.headers)) {
    const presented = bearerTokenFromRequest(req);
    const fresh = presented
      ? await rotateSession(presented, Date.now(), "bearer")
      : await createSession(Date.now(), "bearer");
    setSessionTokenHeader(res, fresh);
    return;
  }
  const presented = sessionTokenFromRequest(req);
  const fresh = presented ? await rotateSession(presented) : await createSession();
  setSessionCookie(res, fresh);
}

/**
 * After a sensitive success (exchange, disconnect): rotate the caller's session and hand the
 * new token back the way the old one came (cookie or response header). No-op for the
 * AUTH_MODE=none stand-in.
 */
export async function rotateSessionOnResponse(auth: SessionResult, res: Response): Promise<void> {
  if (!auth.ok || auth.session.synthetic) return;
  if (auth.session.transport === "bearer") {
    setSessionTokenHeader(res, await rotateSession(auth.raw, Date.now(), "bearer"));
    return;
  }
  const fresh = await rotateSession(auth.raw);
  setSessionCookie(res, fresh);
}
