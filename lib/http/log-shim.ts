import "server-only";

// TEMPORARY (WP4): WP3 ships the real redacting logger in lib/log.ts. When it merges, WP3/WP8
// delete this file and replace `logEvent(event, fields)` with `log.warn(event, fields)`.
// Contract kept deliberately tiny: event name + flat fields, secrets stripped before printing.

const SENSITIVE_KEY = /token|secret|password|cookie|authorization/i;
// Plaid-style token values (access-sandbox-..., public-production-...), defence in depth.
const TOKEN_VALUE = /\b(?:access|public|link|processor)-(?:sandbox|development|production)-[\w-]+/g;

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(k) || v === undefined) continue;
    clean[k] = typeof v === "string" ? v.replace(TOKEN_VALUE, "[redacted]") : v;
  }
  console.warn(JSON.stringify({ event, ...clean }));
}
