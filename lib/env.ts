import "server-only";

export type StorageDriver = "sqlite" | "libsql" | "postgres";
export type AuthMode = "none" | "required";
export type PlaidEnv = "sandbox" | "development" | "production";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

function oneOf<T extends string>(name: string, allowed: T[], fallback: T): T {
  const v = process.env[name];
  if (!v) return fallback;
  if (!allowed.includes(v as T)) {
    throw new Error(
      `${name} must be one of ${allowed.join("|")}, got "${v}"`
    );
  }
  return v as T;
}

// ---------------------------------------------------------------------------
// Parallel work packages append to the labelled blocks below (one var per line)
// so that branches do not conflict. Do not reorder existing lines.
// ---------------------------------------------------------------------------

// --- Plaid ---
const PLAID_ENV = oneOf<PlaidEnv>(
  "PLAID_ENV",
  ["sandbox", "development", "production"],
  "sandbox"
);

// --- Storage ---
const STORAGE = oneOf<StorageDriver>(
  "STORAGE",
  ["sqlite", "libsql", "postgres"],
  "sqlite"
);

if ((STORAGE === "libsql" || STORAGE === "postgres") && !process.env.DATABASE_URL) {
  throw new Error(`STORAGE=${STORAGE} requires DATABASE_URL to be set`);
}

// --- Auth ---
// WP2: auth
// `required` is the default (SECURITY.md F-01). `none` is a local-sandbox
// footgun and is refused in production by lib/boot.ts. `password`/`passkey`
// modes are gone (F-15): factors are enrolled at runtime, not chosen by env.
const AUTH_MODE = oneOf<AuthMode>("AUTH_MODE", ["none", "required"], "required");
// Exact browser origin the app is served from, e.g. http://localhost:3000 or
// https://cards.example. Used for the CSRF Origin check and as the WebAuthn
// RP origin. Required when AUTH_MODE=required (enforced in lib/boot.ts so that
// `next build` does not need it).
const APP_ORIGIN = parseOrigin("APP_ORIGIN");
// One-time bootstrap secret: consulted ONLY while zero factors are enrolled.
const AUTH_SETUP_TOKEN = optionalMinLength("AUTH_SETUP_TOKEN", 32);
// "1" drops the __Host- prefix and the Secure flag so a plain-http LAN box can
// be tested. Refused in production by lib/boot.ts.
const COOKIE_INSECURE_DEV = process.env.COOKIE_INSECURE_DEV === "1";

function parseOrigin(name: string): string | null {
  const v = process.env[name];
  if (!v || v.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(v.trim());
  } catch {
    throw new Error(`${name} must be an absolute http(s) origin, e.g. http://localhost:3000`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`${name} must be an origin only (no path, query or fragment)`);
  }
  return url.origin;
}

function optionalMinLength(name: string, min: number): string | null {
  const v = process.env[name];
  if (!v || v.trim() === "") return null;
  if (v.length < min) {
    throw new Error(`${name} must be at least ${min} characters`);
  }
  return v;
}

// WP3: data key

// WP6b: link
// Exact URL registered in the Plaid dashboard for OAuth institutions (e.g.
// http://localhost:3000/plaid/oauth). Sent as `redirect_uri` on Link tokens only when set.
const PLAID_REDIRECT_URI = parseRedirectUri("PLAID_REDIRECT_URI");

function parseRedirectUri(name: string): string | null {
  const v = process.env[name];
  if (!v || v.trim() === "") return null;
  const raw = v.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL, e.g. http://localhost:3000/plaid/oauth`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  if (url.search || url.hash || raw.includes("?") || raw.includes("#")) {
    throw new Error(`${name} must not contain a query string or fragment`);
  }
  // Plaid compares the string byte-for-byte, so keep exactly what the owner registered.
  return raw;
}

// WP4: cron
// Optional bearer secret for headless /api/plaid/sync (scripts/sync.mjs). When set it must be
// high-entropy (>= 32 chars), e.g. `openssl rand -base64 32`.
const CRON_SECRET = process.env.CRON_SECRET?.trim() || null;
if (CRON_SECRET !== null && CRON_SECRET.length < 32) {
  throw new Error("CRON_SECRET must be at least 32 characters (or unset)");
}

export const env = Object.freeze({
  // --- Plaid ---
  PLAID_CLIENT_ID: requireEnv("PLAID_CLIENT_ID"),
  PLAID_SECRET: requireEnv("PLAID_SECRET"),
  PLAID_ENV,
  PLAID_COUNTRY_CODES: optional("PLAID_COUNTRY_CODES", "US,CA")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean),

  // --- Storage ---
  STORAGE,
  DB_PATH: optional("DB_PATH", "data/amexlens.sqlite"),
  DATABASE_URL: process.env.DATABASE_URL ?? null,

  // WP2: auth
  AUTH_MODE,
  APP_ORIGIN,
  AUTH_SETUP_TOKEN,
  COOKIE_INSECURE_DEV,

  // WP3: data key
  TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY ?? null,
  TOKEN_ENCRYPTION_KEY_FILE: process.env.TOKEN_ENCRYPTION_KEY_FILE ?? null,

  // WP4: cron
  CRON_SECRET,

  // WP6b: link
  PLAID_REDIRECT_URI,
});

export type Env = typeof env;
