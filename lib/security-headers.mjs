// Response security headers per docs/SECURITY.md 3.10 (finding F-09).
// Plain ESM with no app imports so next.config.mjs and vitest can both load it.

const PLAID_HOSTS = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

/**
 * Build the Content-Security-Policy string.
 *
 * TEMPORARY DEVIATION: script-src carries 'unsafe-inline' because Next.js App
 * Router emits inline bootstrap scripts and there is no per-request nonce yet.
 * SECURITY.md 3.10 forbids it long term. WP5b adds a middleware nonce and
 * removes 'unsafe-inline'.
 */
export function buildCsp({ dev = false, plaidEnv = "sandbox" } = {}) {
  const plaidHost = PLAID_HOSTS[plaidEnv] ?? PLAID_HOSTS.sandbox;

  const scriptSrc = ["'self'", "'unsafe-inline'", "https://cdn.plaid.com"];
  const connectSrc = ["'self'", plaidHost];
  if (dev) {
    // Next dev server: React refresh / HMR needs eval and a websocket.
    scriptSrc.push("'unsafe-eval'");
    connectSrc.push("ws://localhost:*", "wss://localhost:*", "ws://127.0.0.1:*", "wss://127.0.0.1:*");
  }

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ${connectSrc.join(" ")}`,
    "frame-src https://cdn.plaid.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  if (!dev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/**
 * Headers for every response. HSTS only when `hsts` is true (HTTPS hosts only).
 *
 * Cross-Origin-Embedder-Policy is deliberately never set: require-corp breaks
 * Plaid Link. COOP is same-origin-allow-popups so issuer OAuth popups work.
 */
export function securityHeaders({ dev = false, hsts = false, plaidEnv } = {}) {
  const headers = [
    { key: "Content-Security-Policy", value: buildCsp({ dev, plaidEnv }) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  ];
  if (hsts) {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  }
  return headers;
}

export const noStore = { key: "Cache-Control", value: "no-store" };
