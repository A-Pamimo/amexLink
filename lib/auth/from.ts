// Post-login redirect allowlist (SECURITY.md 3.3 "Login redirect", F-10 / C-I5).
// Shared by the login page (client) and anything server-side; no node imports.

const SAFE_PATH = /^\/[A-Za-z0-9/_\-]*$/;

/**
 * Returns `from` only when it is a single-slash relative path made of
 * `[A-Za-z0-9/_-]`. Rejects schemes, `//host`, backslashes, query strings and
 * anything else by falling back to `/`.
 */
export function safeFrom(from: string | null | undefined): string {
  if (typeof from !== "string") return "/";
  if (!SAFE_PATH.test(from)) return "/";
  if (from.startsWith("//")) return "/";
  return from;
}
