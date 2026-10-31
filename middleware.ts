import { NextRequest, NextResponse } from "next/server";
import { looksLikeSessionToken, sessionCookieName } from "@/lib/auth/cookie";
import { authMode, cookieInsecureDev } from "@/lib/auth/mode";

/**
 * Edge gate (SECURITY.md 3.3, F-04, F-10). This is a convenience layer only:
 * it never touches the database and it is NOT the authorization check. Every
 * handler validates the session itself (`requireSession` / `requireMutation`
 * as its first statement), so a middleware bypass changes nothing.
 *
 * Behaviour when AUTH_MODE !== "none" and the session cookie is absent or not
 * token-shaped (e.g. the legacy literal `ok`):
 *   - /api/*  → 401 JSON `{ error: { code: "unauthenticated" } }` (never a redirect)
 *   - pages   → 307 to /login?from=<pathname>
 *
 * Exemptions, each with its own authenticator:
 *   /login          the login page; its API calls are gated below
 *   /api/auth/*     own authenticators (setup token, TOTP, passkey, recovery, CSRF)
 *   /api/health     minimal public probe; detail fields sit behind the session (WP4)
 *   /plaid/oauth    Plaid OAuth return page; every API call it makes is gated
 *   /_next/*        framework assets
 *   /favicon.ico    static asset
 *   POST /api/plaid/sync with an Authorization header
 *                   the cron path: `authorizeSync` in the handler compares the bearer to
 *                   CRON_SECRET in constant time and answers 401 on any mismatch. Without the
 *                   header the route is cookie-gated here like every other /api route.
 */
export function middleware(req: NextRequest) {
  if (authMode() === "none") return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/api/health" ||
    pathname === "/plaid/oauth" ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    (pathname === "/api/plaid/sync" && req.method === "POST" && req.headers.has("authorization"))
  ) {
    return NextResponse.next();
  }

  const value = req.cookies.get(sessionCookieName(cookieInsecureDev()))?.value;
  if (looksLikeSessionToken(value)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return new NextResponse(JSON.stringify({ error: { code: "unauthenticated" } }), {
      status: 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
