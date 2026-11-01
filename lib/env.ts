import "server-only";

export type StorageDriver = "sqlite" | "libsql" | "postgres";
export type AuthMode = "none" | "password" | "passkey";
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
const AUTH_MODE = oneOf<AuthMode>(
  "AUTH_MODE",
  ["none", "password", "passkey"],
  "none"
);

if (AUTH_MODE === "password" && !process.env.AUTH_PASSWORD) {
  throw new Error("AUTH_MODE=password requires AUTH_PASSWORD to be set");
}

// WP3: data key

// WP4: cron

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
  AUTH_PASSWORD: process.env.AUTH_PASSWORD ?? null,

  // WP3: data key

  // WP4: cron
});

export type Env = typeof env;
