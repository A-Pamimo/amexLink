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
};

export default nextConfig;
