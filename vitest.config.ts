import path from "node:path";
import { defineConfig } from "vitest/config";

const root = __dirname;

export default defineConfig({
  // tsconfig keeps `jsx: preserve` for Next; tests need the JSX compiled (component tests, .tsx).
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
  resolve: {
    alias: {
      "server-only": path.resolve(root, "test/stubs/server-only.ts"),
      "@": root,
    },
  },
});
