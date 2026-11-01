import { describe, expect, it } from "vitest";
import { api, e2e, expectJson } from "./helpers/client";

/**
 * Middleware exemptions and redirects, probed with path variants an attacker would try.
 *
 * The redirect target is built on APP_ORIGIN (middleware.ts, RT-09). Next's own NextURL then
 * rewrites any loopback IP in a Location to `localhost` (next/dist/server/web/next-url.js,
 * REGEX_LOCALHOST_HOSTNAME), so on this 127.0.0.1 test origin the host reads `localhost:3131`.
 * Both are this machine; a real hostname is passed through unchanged (unit test in
 * test/auth/middleware.test.ts, and the RT-09 probe in docs/RED-TEAM.md).
 */
function ourHosts(): Set<string> {
  const u = new URL(e2e().origin);
  return new Set([u.host, u.host.replace(/^127\.0\.0\.1/, "localhost"), u.host.replace(/^localhost/, "127.0.0.1")]);
}

describe("middleware gate: redirects and path variants", () => {
  it("GET /transactions without a cookie -> 307 to /login?from=%2Ftransactions on our host", async () => {
    const res = await api("/transactions");
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!, e2e().base);
    expect(ourHosts().has(loc.host)).toBe(true);
    expect(loc.protocol).toBe("http:");
    expect(loc.pathname).toBe("/login");
    expect(loc.search).toBe("?from=%2Ftransactions");
    expect(loc.searchParams.get("from")).toBe("/transactions");
    expect(await res.text()).not.toContain("<table");
  });

  it("the query string never travels into `from`", async () => {
    const res = await api("/settings?code=secret&x=1");
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!, e2e().base);
    expect(loc.searchParams.get("from")).toBe("/settings");
    expect(loc.search).not.toContain("secret");
  });

  it("a forged Host / X-Forwarded-Host never reaches the redirect target", async () => {
    const res = await api("/transactions", {
      headers: { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!, e2e().base);
    expect(loc.host).not.toContain("evil");
    expect(ourHosts().has(loc.host)).toBe(true);
  });

  it("protocol-relative and odd paths never redirect off-host", async () => {
    for (const p of ["//evil.example/x", "/\\evil.example", "/%2F%2Fevil.example", "/..%2F..%2Fetc%2Fpasswd"]) {
      const res = await api(p);
      expect(res.status, p).not.toBe(200);
      const loc = res.headers.get("location");
      if (loc) {
        const u = new URL(loc, e2e().base);
        expect(ourHosts().has(u.host), `${p} -> ${loc}`).toBe(true);
      }
    }
  });

  it("exemption prefixes do not stretch to look-alike paths", async () => {
    const looksAlike = [
      "/loginx",
      "/login-page",
      "/login%20",
      "/plaid/oauthx",
      "/plaid/oauth/..",
      "/api/authx/status",
      "/api/auth%2Fstatus",
      "/api/healthx",
      "/api/health/x",
      "/api/health/../items",
      "/api/items/",
      "/api/items%2F",
      "/api/%69tems",
      "/API/items",
      "/api/Items",
      "/api//items",
      "/_next/../api/items",
      "/favicon.ico/../api/items",
    ];
    for (const p of looksAlike) {
      const res = await api(p);
      expect(res.status, p).not.toBe(200);
      // 401 JSON from the gate, a 307/308 to /login or the canonical path, or 404; never data.
      expect([401, 404, 307, 308], p).toContain(res.status);
      if (res.status === 401) expect(await expectJson(res)).toEqual({ error: { code: "unauthenticated" } });
      if (res.status === 307 || res.status === 308) {
        const loc = new URL(res.headers.get("location")!, e2e().base);
        expect(ourHosts().has(loc.host), `${p} -> ${loc.href}`).toBe(true);
      }
    }
  });

  it("the public pages are served without a cookie and contain nothing sensitive", async () => {
    for (const p of ["/login", "/login?from=%2F%2Fevil.example", "/plaid/oauth"]) {
      const res = await api(p);
      expect(res.status, p).toBe(200);
      const html = await res.text();
      expect(html).not.toMatch(/access-(sandbox|development|production)-/);
      expect(html).not.toContain(e2e().setupToken);
      expect(html).not.toContain(e2e().cronSecret);
    }
  });

  it("API routes are never redirected to HTML", async () => {
    for (const p of ["/api/items", "/api/cards", "/api/transactions", "/api/system", "/api/stats/totals"]) {
      const res = await api(p, { headers: { accept: "text/html,application/xhtml+xml" } });
      expect(res.status, p).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/json/);
    }
  });
});
