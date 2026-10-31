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
 * script-src never contains 'unsafe-inline' (SECURITY.md 3.10, F-09). Pages get
 * a per-request `nonce` from middleware.ts; Next.js App Router reads it from
 * the request's CSP header and stamps it on its own inline bootstrap scripts
 * and script tags (only for dynamically rendered pages, see app/layout.tsx).
 * Without a nonce (the static policy on /api/*, which serves JSON only) no
 * inline script is allowed at all.
 *
 * 'strict-dynamic' is deliberately NOT used. react-plaid-link@5 injects
 * https://cdn.plaid.com/link/v2/stable/link-initialize.js with
 * document.createElement('script') from a React effect, so a nonce'd parent
 * would trust it under 'strict-dynamic'. But 'strict-dynamic' makes browsers
 * ignore the host allowlist, link-initialize.js itself is third-party code we
 * cannot audit for further script injection, and the Plaid flow cannot be
 * exercised in a real browser in CI. The host allowlist plus nonce is
 * sufficient and fails safer. Revisit only with a browser-verified Link run.
 */
export function buildCsp({ nonce, dev = false, plaidEnv = "sandbox" } = {}) {
  const plaidHost = PLAID_HOSTS[plaidEnv] ?? PLAID_HOSTS.sandbox;

  const scriptSrc = ["'self'"];
  if (nonce) scriptSrc.push(`'nonce-${nonce}'`);
  scriptSrc.push("https://cdn.plaid.com");
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
 * Pass `csp: false` to omit Content-Security-Policy (HTML responses get theirs,
 * with a nonce, from middleware.ts).
 *
 * Cross-Origin-Embedder-Policy is deliberately never set: require-corp breaks
 * Plaid Link. COOP is same-origin-allow-popups so issuer OAuth popups work.
 */
export function securityHeaders({ dev = false, hsts = false, plaidEnv, csp = true } = {}) {
  const headers = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  ];
  if (csp) headers.unshift({ key: "Content-Security-Policy", value: buildCsp({ dev, plaidEnv }) });
  if (hsts) {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  }
  return headers;
}

export const noStore = { key: "Cache-Control", value: "no-store" };
