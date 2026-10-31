import "server-only";
import { randomToken, sha256Hex } from "../crypto";
import { getDB, type SessionRow } from "../db";
import {
  cookieOptions,
  readCookie,
  serializeSessionCookie,
  sessionCookieName,
  looksLikeSessionToken,
  SESSION_TTL_SECONDS,
} from "./cookie";
import { authMode, cookieInsecureDev } from "./mode";
import { errorJson } from "./http";

/**
 * Server-side sessions (SECURITY.md 3.3 "Session", F-02, C-S1..C-S3).
 *
 * - raw token: 32 random bytes, base64url, lives only in the cookie;
 * - DB stores sha256(raw) as the row id;
 * - absolute lifetime 12 h, idle timeout 2 h, `last_seen_at` touched at most
 *   once per minute;
 * - logout / rotate delete the row, so every other copy of the cookie dies.
 *
 * Nothing here logs or returns the raw token except to the Set-Cookie header.
 */

export const ABSOLUTE_TTL_MS = SESSION_TTL_SECONDS * 1000;
export const IDLE_TTL_MS = 2 * 3600 * 1000;
export const TOUCH_INTERVAL_MS = 60 * 1000;

export interface Session {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  /** True when AUTH_MODE=none produced a stand-in session (no row, no cookie). */
  synthetic: boolean;
}

export type SessionResult =
  | { ok: true; session: Session; /** raw cookie value, for rotate/logout; never log it */ raw: string | null }
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

/** Create a session row and return the raw token to put in the cookie. */
export async function createSession(now: number = Date.now()): Promise<string> {
  const raw = randomToken(32);
  const db = await getDB();
  const iso = new Date(now).toISOString();
  await db.createSession({
    id: sha256Hex(raw),
    created_at: iso,
    last_seen_at: iso,
    expires_at: new Date(now + ABSOLUTE_TTL_MS).toISOString(),
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
  if (now - lastSeen > IDLE_TTL_MS) return false;
  return true;
}

/**
 * Look up the session named by the cookie. On success, touches `last_seen_at`
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
        synthetic: true,
      },
    };
  }

  const raw = sessionTokenFromRequest(req);
  if (!raw) return { ok: false, response: unauthenticated() };

  const db = await getDB();
  const id = sha256Hex(raw);
  const row = await db.getSession(id);
  if (!row) return { ok: false, response: unauthenticated() };
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
    session: { ...row, last_seen_at, synthetic: false },
  };
}

/** Issue a new token and delete the old row (login, link, disconnect). */
export async function rotateSession(oldRaw: string | null, now: number = Date.now()): Promise<string> {
  const db = await getDB();
  const fresh = await createSession(now);
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

/**
 * Login / first-factor enrolment success: mint a session (rotating any token
 * the browser already presented) and set the cookie on `res`.
 */
export async function issueSessionCookie(req: Request, res: Response): Promise<void> {
  const presented = sessionTokenFromRequest(req);
  const fresh = presented ? await rotateSession(presented) : await createSession();
  setSessionCookie(res, fresh);
}

/**
 * After a sensitive success (exchange, disconnect): rotate the caller's session
 * and put the new cookie on `res`. No-op for the AUTH_MODE=none stand-in.
 */
export async function rotateSessionOnResponse(auth: SessionResult, res: Response): Promise<void> {
  if (!auth.ok || auth.session.synthetic) return;
  const fresh = await rotateSession(auth.raw);
  setSessionCookie(res, fresh);
}
