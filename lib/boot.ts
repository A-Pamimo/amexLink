import "server-only";
import { env } from "./env";
import { loadDataKey } from "./crypto";
import { assertLeastPrivilege } from "./plaid";

/**
 * Fail fast at server start (called from instrumentation.ts) instead of on the
 * first request. Later work packages add their boot refusals here.
 */
export function assertBootConfig(): void {
  // Importing ./env validates required vars and throws on invalid values.
  void env;

  // Files created by the app (SQLite DB, WAL, backups) default to owner-only.
  process.umask(0o077);

  // WP3: data key. Refuse to start without a valid 32-byte key; there is no
  // plaintext fallback for tokens (SECURITY.md 3.1 "fail closed").
  loadDataKey();

  // WP6a: scopes. Refuse to start if the Link product lists ever widen beyond
  // Transactions + Liabilities (SECURITY.md 3.5, P-E1).
  assertLeastPrivilege();

  // WP2: auth (SECURITY.md 3.1 "fail closed", F-01).
  // "Production" for the auth gate is the Node build (NODE_ENV). "Production" for the
  // transport rules is the Plaid environment: live credentials over plain http are what
  // SECURITY.md 3.1 forbids ("PLAID_SECRET present and PLAID_ENV=production while the public
  // base URL is http -> refuse"), while a production Node build on a Tailscale/LAN host may
  // legitimately run sandbox over http.
  const nodeProduction = process.env.NODE_ENV === "production";
  const plaidProduction = env.PLAID_ENV === "production";
  if ((nodeProduction || plaidProduction) && env.AUTH_MODE === "none") {
    throw new Error(
      "AUTH_MODE=none is refused in production. Set AUTH_MODE=required, APP_ORIGIN and AUTH_SETUP_TOKEN."
    );
  }
  if (env.AUTH_MODE === "required" && !env.APP_ORIGIN) {
    throw new Error(
      "AUTH_MODE=required needs APP_ORIGIN (the exact browser origin, e.g. https://cards.example)."
    );
  }
  if (plaidProduction && env.APP_ORIGIN && !env.APP_ORIGIN.startsWith("https://")) {
    throw new Error(
      "APP_ORIGIN must be https:// when PLAID_ENV=production (the session cookie is Secure)."
    );
  }
  if (plaidProduction && env.COOKIE_INSECURE_DEV) {
    throw new Error("COOKIE_INSECURE_DEV=1 is refused when PLAID_ENV=production.");
  }
}
