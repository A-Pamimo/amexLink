import path from "node:path";
import { defineConfig } from "vitest/config";

const root = __dirname;

/**
 * Attacker suite (docs/RED-TEAM.md, WP9). `npm run test:e2e`.
 *
 * test/e2e/global-setup.ts builds the app once (`next build`, skipped with
 * E2E_SKIP_BUILD=1), starts `next start -H 127.0.0.1 -p 3131` against a temp
 * DB_PATH with AUTH_MODE=required, enrols a known TOTP secret through the real
 * setup routes, and kills the server by PID in teardown. Every test is a real
 * HTTP request (or a real Chromium page) against that process.
 *
 * Files run one at a time: they share one server, one lockout table and one
 * TOTP replay window.
 */
export default defineConfig({
  test: {
    name: "e2e",
    environment: "node",
    include: ["test/e2e/**/*.e2e.ts"],
    globalSetup: ["test/e2e/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 240_000,
    teardownTimeout: 30_000,
  },
  resolve: {
    alias: {
      "server-only": path.resolve(root, "test/stubs/server-only.ts"),
      "@": root,
    },
  },
});
