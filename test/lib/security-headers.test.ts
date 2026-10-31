import { describe, expect, it } from "vitest";
import { buildCsp, noStore, securityHeaders } from "@/lib/security-headers.mjs";
// @ts-expect-error plain ESM module without type declarations
import nextConfig from "@/next.config.mjs";

type Header = { key: string; value: string };

function directive(csp: string, name: string): string[] {
  const part = csp.split("; ").find((d) => d.startsWith(`${name} `));
  if (!part) throw new Error(`missing directive ${name}`);
  return part.split(" ").slice(1);
}

function get(headers: Header[], key: string): string | undefined {
  return headers.find((h) => h.key === key)?.value;
}

describe("buildCsp", () => {
  it("has no unsafe-eval in production and has it in dev", () => {
    expect(buildCsp({ dev: false })).not.toContain("'unsafe-eval'");
    expect(directive(buildCsp({ dev: true }), "script-src")).toContain("'unsafe-eval'");
  });

  it("limits script-src to self, the nonce and cdn.plaid.com, never unsafe-inline", () => {
    const scriptSrc = directive(buildCsp({ nonce: "abc123==" }), "script-src");
    expect(scriptSrc).toEqual(["'self'", "'nonce-abc123=='", "https://cdn.plaid.com"]);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'strict-dynamic'");
    // Without a nonce (static /api policy) no inline script is allowed at all.
    expect(directive(buildCsp(), "script-src")).toEqual(["'self'", "https://cdn.plaid.com"]);
    expect(directive(buildCsp({ dev: true, nonce: "n" }), "script-src")).not.toContain("'unsafe-inline'");
  });

  it("keeps unsafe-inline for styles and adds unsafe-eval to script-src only in dev", () => {
    expect(directive(buildCsp({ nonce: "n" }), "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(buildCsp({ nonce: "n", dev: true }), "script-src")).toContain("'unsafe-eval'");
    expect(directive(buildCsp({ nonce: "n", dev: false }), "script-src")).not.toContain("'unsafe-eval'");
  });

  it("scopes connect-src to the configured Plaid environment", () => {
    const prod = directive(buildCsp({ plaidEnv: "production" }), "connect-src");
    expect(prod).toContain("https://production.plaid.com");
    expect(prod.join(" ")).not.toContain("sandbox");
    expect(directive(buildCsp({ plaidEnv: "sandbox" }), "connect-src")).toEqual([
      "'self'",
      "https://sandbox.plaid.com",
    ]);
    expect(directive(buildCsp({ plaidEnv: "development" }), "connect-src")).toEqual([
      "'self'",
      "https://development.plaid.com",
    ]);
  });

  it("allows websockets to localhost only in dev, and upgrades only outside dev", () => {
    const dev = buildCsp({ dev: true });
    expect(directive(dev, "connect-src").some((s) => s.startsWith("ws://localhost"))).toBe(true);
    expect(dev).not.toContain("upgrade-insecure-requests");
    const prod = buildCsp({ dev: false });
    expect(prod).not.toContain("ws:");
    expect(prod).toContain("upgrade-insecure-requests");
  });

  it("denies framing, plugins and foreign base/form targets", () => {
    const csp = buildCsp();
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "base-uri")).toEqual(["'self'"]);
    expect(directive(csp, "form-action")).toEqual(["'self'"]);
    expect(directive(csp, "img-src")).toEqual(["'self'", "data:"]);
    expect(directive(csp, "frame-src")).toEqual(["https://cdn.plaid.com"]);
  });
});

describe("securityHeaders", () => {
  it("sets HSTS only when hsts is true", () => {
    expect(get(securityHeaders(), "Strict-Transport-Security")).toBeUndefined();
    expect(get(securityHeaders({ hsts: false }), "Strict-Transport-Security")).toBeUndefined();
    expect(get(securityHeaders({ hsts: true }), "Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("never sets Cross-Origin-Embedder-Policy", () => {
    for (const opts of [{}, { dev: true }, { hsts: true }, { plaidEnv: "production" }]) {
      expect(get(securityHeaders(opts), "Cross-Origin-Embedder-Policy")).toBeUndefined();
    }
  });

  it("sets the SECURITY.md 3.10 values", () => {
    const h = securityHeaders();
    expect(get(h, "Referrer-Policy")).toBe("no-referrer");
    expect(get(h, "Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
    expect(get(h, "Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(get(h, "X-Frame-Options")).toBe("DENY");
    expect(get(h, "X-Content-Type-Options")).toBe("nosniff");
    expect(get(h, "Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=(), payment=()");
    expect(get(h, "Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("omits the CSP when csp is false and keeps every other header", () => {
    const h = securityHeaders({ csp: false, hsts: true });
    expect(get(h, "Content-Security-Policy")).toBeUndefined();
    expect(get(h, "X-Frame-Options")).toBe("DENY");
    expect(get(h, "Strict-Transport-Security")).toBeTruthy();
  });

  it("exports Cache-Control: no-store", () => {
    expect(noStore).toEqual({ key: "Cache-Control", value: "no-store" });
  });
});

describe("next.config.mjs headers()", () => {
  it("leaves the CSP to middleware for HTML, keeps a static one on /api, and no-store on both", async () => {
    const entries = (await nextConfig.headers()) as { source: string; headers: Header[] }[];
    const all = entries.find((e) => e.source === "/:path*");
    expect(all).toBeTruthy();
    expect(get(all!.headers, "Content-Security-Policy")).toBeUndefined();
    expect(get(all!.headers, "X-Frame-Options")).toBe("DENY");
    const api = entries.find((e) => e.source === "/api/:path*");
    expect(api && get(api.headers, "Cache-Control")).toBe("no-store");
    const apiCsp = api && get(api.headers, "Content-Security-Policy");
    expect(apiCsp).toContain("frame-ancestors 'none'");
    expect(directive(apiCsp!, "script-src")).not.toContain("'unsafe-inline'");
    const html = entries.find((e) => e.source === "/((?!_next/static|_next/image|favicon.ico).*)");
    expect(html && get(html.headers, "Cache-Control")).toBe("no-store");
    expect(html && get(html.headers, "Content-Security-Policy")).toBeUndefined();
  });
});
