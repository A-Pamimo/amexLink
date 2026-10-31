// Edge-safe view of the auth env (middleware cannot import lib/env, which is
// server-only and validates Plaid vars). Read at call time, not at import, so
// tests can flip the mode. Anything that is not exactly "none" is treated as
// "required" (fail closed); lib/env.ts rejects other values at server start.

export type AuthMode = "none" | "required";

export function authMode(): AuthMode {
  const v = (process.env.AUTH_MODE ?? "").trim();
  return v === "none" ? "none" : "required";
}

export function cookieInsecureDev(): boolean {
  return process.env.COOKIE_INSECURE_DEV === "1";
}
