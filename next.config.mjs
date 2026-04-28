/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    // better-sqlite3 is a native module; keep it out of the bundler.
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
};

export default nextConfig;
