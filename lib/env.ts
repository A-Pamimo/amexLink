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

const PLAID_ENV = oneOf<PlaidEnv>(
  "PLAID_ENV",
  ["sandbox", "development", "production"],
  "sandbox"
);

const STORAGE = oneOf<StorageDriver>(
  "STORAGE",
  ["sqlite", "libsql", "postgres"],
  "sqlite"
);

const AUTH_MODE = oneOf<AuthMode>(
  "AUTH_MODE",
  ["none", "password", "passkey"],
  "none"
);

if ((STORAGE === "libsql" || STORAGE === "postgres") && !process.env.DATABASE_URL) {
  throw new Error(`STORAGE=${STORAGE} requires DATABASE_URL to be set`);
}

if (AUTH_MODE === "password" && !process.env.AUTH_PASSWORD) {
  throw new Error("AUTH_MODE=password requires AUTH_PASSWORD to be set");
}

const APP_SECRET = requireEnv("APP_SECRET");
if (APP_SECRET.length < 32) {
  throw new Error(
    "APP_SECRET must be at least 32 chars. Generate one with: openssl rand -base64 48"
  );
}

export const env = Object.freeze({
  PLAID_CLIENT_ID: requireEnv("PLAID_CLIENT_ID"),
  PLAID_SECRET: requireEnv("PLAID_SECRET"),
  PLAID_ENV,
  PLAID_COUNTRY_CODES: optional("PLAID_COUNTRY_CODES", "US,CA")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean),
  STORAGE,
  DB_PATH: optional("DB_PATH", "data/amexlens.sqlite"),
  DATABASE_URL: process.env.DATABASE_URL ?? null,
  AUTH_MODE,
  AUTH_PASSWORD: process.env.AUTH_PASSWORD ?? null,
  APP_SECRET,
  COOKIE_SECURE: (process.env.COOKIE_SECURE ?? "auto") as "auto" | "true" | "false",
  CSRF_ALLOWED_ORIGINS: process.env.CSRF_ALLOWED_ORIGINS ?? null,
});

export type Env = typeof env;
