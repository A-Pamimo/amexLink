import { NextRequest, NextResponse } from "next/server";
import { looksLikeSessionToken, sessionCookieName } from "@/lib/auth/cookie";
import { authMode, cookieInsecureDev } from "@/lib/auth/mode";
import { buildCsp } from "@/lib/security-headers.mjs";

/**
 * Per-request CSP nonce (SECURITY.md 3.10, F-09). Every non-API response gets
 * `Content-Security-Policy` with `script-src 'self' 'nonce-<n>' https://cdn.plaid.com`
 * (no 'unsafe-inline'). The same policy and `x-nonce` are forwarded as request
 * headers: Next.js App Router reads the nonce from the request's CSP header and
 * stamps it on its own inline scripts (pages must render dynamically, see
 * app/layout.tsx). This adds headers only; it changes no auth decision.
 * /api/* responses are JSON and keep the static CSP from next.config.mjs.
 */
function makeNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

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
  const { pathname } = req.nextUrl;
  const nonce = makeNonce();
  const csp = buildCsp({
    nonce,
    dev: process.env.NODE_ENV !== "production",
    plaidEnv: process.env.PLAID_ENV ?? "sandbox",
  });
  const isApi = pathname.startsWith("/api/");

  /** Pass the request on; pages get the nonce and CSP. */
  const next = () => {
    if (isApi) return NextResponse.next();
    const headers = new Headers(req.headers);
    headers.set("x-nonce", nonce);
    headers.set("content-security-policy", csp);
    const res = NextResponse.next({ request: { headers } });
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };

  if (authMode() === "none") return next();

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
    return next();
  }

  const value = req.cookies.get(sessionCookieName(cookieInsecureDev()))?.value;
  if (looksLikeSessionToken(value)) return next();

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
  const redirect = NextResponse.redirect(url);
  redirect.headers.set("Content-Security-Policy", csp);
  return redirect;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
