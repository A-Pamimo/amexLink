import "server-only";

// Origin-based CSRF defence. Same-site=lax cookies cover most cases, but for
// state-changing endpoints we still want a positive Origin/Referer check so
// cross-origin POSTs from a malicious page are rejected even if the user is
// authenticated.
export function assertSameOrigin(req: Request): { ok: true } | { ok: false; reason: string } {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return { ok: true };
  }
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const host = req.headers.get("host");
  if (!host) return { ok: false, reason: "no host header" };

  const expected = new Set<string>();
  // Allow http+https for the bound host (covers localhost, LAN IPs, prod TLS).
  expected.add(`https://${host}`);
  expected.add(`http://${host}`);
  // Optional explicit allowlist for trusted reverse proxies / additional hostnames.
  const extra = (process.env.CSRF_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const e of extra) expected.add(e);

  const candidate = origin ?? (referer ? new URL(referer).origin : null);
  if (!candidate) return { ok: false, reason: "missing origin and referer" };
  if (!expected.has(candidate)) {
    return { ok: false, reason: `origin ${candidate} not allowed` };
  }
  return { ok: true };
}
