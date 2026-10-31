import { beforeAll, describe, expect, it } from "vitest";
import { api, e2e, mintSession } from "./helpers/client";

/** SECURITY.md 3.10 on HTML and /api/*, verified over the wire (checklist: "verified with curl -I"). */

function directive(csp: string, name: string): string[] {
  const part = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `) || d === name);
  if (part === undefined) throw new Error(`missing directive ${name} in: ${csp}`);
  return part.split(/\s+/).slice(1);
}

function expectBaseline(res: Response): void {
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
  expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=(), payment=()");
  // Next's own not-found page adds `private, no-cache, ...`; every response must still say no-store.
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(res.headers.get("x-powered-by")).toBeNull();
  expect(res.headers.get("cross-origin-embedder-policy")).toBeNull();
}

function expectHtmlCsp(res: Response): string {
  const csp = res.headers.get("content-security-policy");
  expect(csp).toBeTruthy();
  const scriptSrc = directive(csp!, "script-src");
  const nonce = scriptSrc.find((s) => s.startsWith("'nonce-"));
  expect(nonce).toBeTruthy();
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(scriptSrc).not.toContain("'unsafe-eval'");
  expect(scriptSrc).not.toContain("'strict-dynamic'");
  expect(scriptSrc).toEqual(expect.arrayContaining(["'self'", "https://cdn.plaid.com"]));
  expect(directive(csp!, "frame-ancestors")).toEqual(["'none'"]);
  expect(directive(csp!, "object-src")).toEqual(["'none'"]);
  expect(directive(csp!, "img-src")).toEqual(["'self'", "data:"]);
  expect(directive(csp!, "frame-src")).toEqual(["https://cdn.plaid.com"]);
  expect(directive(csp!, "connect-src")).toEqual(["'self'", "https://sandbox.plaid.com"]);
  expect(directive(csp!, "base-uri")).toEqual(["'self'"]);
  expect(directive(csp!, "form-action")).toEqual(["'self'"]);
  return nonce!.slice("'nonce-".length, -1);
}

describe("response headers", () => {
  let session: string;
  beforeAll(async () => {
    session = await mintSession();
  });

  it("/api/health body is exactly {\"ok\":true} and carries the API headers", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expectBaseline(res);
    const csp = res.headers.get("content-security-policy")!;
    expect(directive(csp, "script-src")).toEqual(["'self'", "https://cdn.plaid.com"]);
  });

  it("/login (public HTML) has a nonce'd CSP and the baseline headers", async () => {
    const res = await api("/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expectBaseline(res);
    const nonce = expectHtmlCsp(res);
    const html = await res.text();
    // Next stamps the per-request nonce on its inline bootstrap scripts; no executable inline
    // script may appear without it (enforcement itself is checked in Chromium, browser.e2e.ts).
    expect(html).toContain(`nonce="${nonce}"`);
    const inlineWithoutNonce = [...html.matchAll(/<script\b([^>]*)>(?!<\/script>)/g)].filter(
      ([, attrs]) => !/\bsrc=/.test(attrs) && !/\bnonce=/.test(attrs) && !/\btype="(?!module|text\/javascript)/.test(attrs)
    );
    expect(inlineWithoutNonce).toEqual([]);
  });

  it("the nonce changes on every request", async () => {
    const a = expectHtmlCsp(await api("/login"));
    const b = expectHtmlCsp(await api("/login"));
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(22);
  });

  it("/ redirects without a session and renders with one; both carry the headers", async () => {
    const anon = await api("/");
    expect(anon.status).toBe(307);
    expectBaseline(anon);
    expect(anon.headers.get("content-security-policy")).toContain("'nonce-");

    const auth = await api("/", { session });
    expect(auth.status).toBe(200);
    expectBaseline(auth);
    expectHtmlCsp(auth);
  });

  it("/settings and /transactions (session) carry the headers", async () => {
    for (const p of ["/settings", "/transactions", "/spending"]) {
      const res = await api(p, { session });
      expect(res.status, p).toBe(200);
      expectBaseline(res);
      expectHtmlCsp(res);
    }
  });

  it("/api/items: 401 and 200 both carry the API headers and a static CSP", async () => {
    for (const res of [await api("/api/items"), await api("/api/items", { session })]) {
      expectBaseline(res);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const csp = res.headers.get("content-security-policy")!;
      expect(directive(csp, "script-src")).toEqual(["'self'", "https://cdn.plaid.com"]);
      expect(csp).not.toContain("'unsafe-inline' https");
    }
  });

  it("an unknown page and an unknown API path still carry the headers and never 200", async () => {
    const page = await api("/definitely-not-a-page", { session });
    expect(page.status).toBe(404);
    expectBaseline(page);
    const apiMissing = await api("/api/definitely-not-a-route", { session });
    expect([404, 405]).toContain(apiMissing.status);
    expectBaseline(apiMissing);
    const anon = await api("/api/definitely-not-a-route");
    expect(anon.status).toBe(401);
  });

  it("/_next/static assets are cacheable (not no-store) and not framed", async () => {
    const html = await (await api("/login")).text();
    const m = /src="(\/_next\/static\/[^"]+\.js)"/.exec(html);
    expect(m, "found a static script in /login").toBeTruthy();
    const asset = await api(m![1]);
    expect(asset.status).toBe(200);
    const cc = asset.headers.get("cache-control") ?? "";
    expect(cc).not.toContain("no-store");
    expect(cc).toMatch(/max-age=\d+/);
    expect(asset.headers.get("x-frame-options")).toBe("DENY");
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("HSTS is absent on this plain-http deployment", async () => {
    const res = await api("/login");
    expect(res.headers.get("strict-transport-security")).toBeNull();
    expect(e2e().origin.startsWith("http://")).toBe(true);
  });
});
