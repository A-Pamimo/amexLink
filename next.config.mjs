import { buildCsp, isPlainHttpOrigin, noStore, securityHeaders } from "./lib/security-headers.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    // Lint runs in CI (`npm run lint`), not during `next build`.
    ignoreDuringBuilds: true,
  },
  // better-sqlite3 is a native module; keep it out of the bundler.
  serverExternalPackages: ["better-sqlite3"],
  // SECURITY.md 3.10 / F-09. Headers apply to every response, not only HTML.
  // HTML responses get their Content-Security-Policy from middleware.ts, which
  // adds a per-request script nonce; a static CSP here would conflict with it.
  // /api/* serves JSON only, so it keeps a static, nonce-less CSP.
  // NOTE: headers() runs at BUILD time. Anything that must follow the deploy host's runtime
  // environment (HSTS via ENABLE_HSTS, the http/https origin) is set in middleware.ts instead.
  async headers() {
    const dev = process.env.NODE_ENV !== "production";
    const plaidEnv = process.env.PLAID_ENV ?? "sandbox";
    const upgrade = !dev && !isPlainHttpOrigin(process.env.APP_ORIGIN);
    return [
      {
        source: "/:path*",
        headers: securityHeaders({ dev, hsts: false, plaidEnv, csp: false }),
      },
      {
        source: "/api/:path*",
        headers: [{ key: "Content-Security-Policy", value: buildCsp({ dev, plaidEnv, upgrade }) }, noStore],
      },
      // HTML routes: everything except static assets (which stay cacheable).
      { source: "/((?!_next/static|_next/image|favicon.ico).*)", headers: [noStore] },
    ];
  },
};

export default nextConfig;
