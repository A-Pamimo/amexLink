import { noStore, securityHeaders } from "./lib/security-headers.mjs";

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
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders({
          dev: process.env.NODE_ENV !== "production",
          hsts: process.env.ENABLE_HSTS === "1",
          plaidEnv: process.env.PLAID_ENV ?? "sandbox",
        }),
      },
      { source: "/api/:path*", headers: [noStore] },
      // HTML routes: everything except static assets (which stay cacheable).
      { source: "/((?!_next/static|_next/image|favicon.ico).*)", headers: [noStore] },
    ];
  },
};

export default nextConfig;
