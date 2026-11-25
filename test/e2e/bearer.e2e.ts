import { describe, expect, it } from "vitest";
import { api, e2e, expectJson, mintSession, reserveTotpCode } from "./helpers/client";

const MOBILE = { "X-AmexLens-Client": "mobile" };

/** Sign in as the native app: no Origin, mobile marker, token comes back in a header. */
async function appLogin(): Promise<string> {
  const code = await reserveTotpCode(e2e().stateFile, { wait: true });
  const res = await api("/api/auth/login/totp", { method: "POST", origin: null, headers: MOBILE, json: { code } });
  expect(res.status).toBe(200);
  expect(res.headers.getSetCookie()).toEqual([]);
  expect(res.headers.get("cache-control")).toBe("no-store");
  // Never readable cross-origin: no CORS headers at all.
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  expect(res.headers.get("access-control-expose-headers")).toBeNull();
  const token = res.headers.get("x-amexlens-session-token");
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await expectJson(res)).toEqual({ ok: true });
  return token!;
}

const bearer = (token: string) => ({ ...MOBILE, authorization: `Bearer ${token}` });

describe("native app bearer sessions over HTTP", () => {
  it("signs in, reads, mutates without Origin, and logs out", async () => {
    const token = await appLogin();
    expect((await api("/api/items", { origin: null, headers: bearer(token) })).status).toBe(200);
    expect((await api("/api/cards", { origin: null, headers: bearer(token) })).status).toBe(200);

    const sync = await api("/api/plaid/sync", { method: "POST", origin: null, headers: bearer(token), json: {} });
    expect(sync.status).not.toBe(401);
    expect(sync.status).not.toBe(403);

    const out = await api("/api/auth/logout", { method: "POST", origin: null, headers: bearer(token), json: {} });
    expect(out.status).toBe(200);
    expect((await api("/api/items", { origin: null, headers: bearer(token) })).status).toBe(401);
  });

  it("tokens are refused on the other transport and on pages", async () => {
    const app = await appLogin();
    const browser = await mintSession();
    // App token as a cookie, browser cookie as a bearer: both 401.
    expect((await api("/api/items", { session: app })).status).toBe(401);
    expect((await api("/api/items", { origin: null, headers: bearer(browser) })).status).toBe(401);
    // A bearer never opens a page: still the login redirect.
    const page = await api("/", { origin: null, headers: bearer(app) });
    expect(page.status).toBe(307);
  });

  it("a forged or unknown bearer is 401 everywhere, including sync", async () => {
    const fake = "A".repeat(43);
    expect((await api("/api/items", { origin: null, headers: bearer(fake) })).status).toBe(401);
    const sync = await api("/api/plaid/sync", { method: "POST", origin: null, headers: bearer(fake), json: {} });
    expect(sync.status).toBe(401);
  });

  it("a cross-site browser request claiming to be the app gets no session", async () => {
    // Without the custom request header (what a cross-site form could send) → 403 before the
    // code is even checked, no token.
    const res = await api("/api/auth/login/totp", {
      method: "POST",
      origin: "https://evil.example",
      csrf: false,
      headers: MOBILE,
      json: { code: "000000" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("x-amexlens-session-token")).toBeNull();
  });
});
