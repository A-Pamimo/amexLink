import { beforeAll, describe, expect, it } from "vitest";
import { api, expectJson, mintSession } from "./helpers/client";

/**
 * CSRF matrix with a VALID session (SECURITY.md 3.3 "CSRF"). The "correct" rows use requests
 * that fail validation after the auth/CSRF gate, so no Plaid call is ever made.
 */
describe("CSRF on state-changing routes (valid session)", () => {
  let session: string;
  beforeAll(async () => {
    session = await mintSession();
  });

  const exchange = (opts: Parameters<typeof api>[1]) =>
    api("/api/plaid/exchange", { method: "POST", session, json: { public_token: "" }, ...opts });

  it("mutation without X-AmexLens-Request -> 403 csrf", async () => {
    const res = await exchange({ csrf: false });
    expect(res.status).toBe(403);
    expect(await expectJson(res)).toEqual({ error: { code: "csrf" } });
  });

  it("header present but Origin is another site -> 403", async () => {
    for (const origin of ["https://evil.example", "http://127.0.0.1:3131.evil.example", "null", "http://localhost:3131"]) {
      const res = await exchange({ origin });
      expect(res.status, origin).toBe(403);
    }
  });

  it("Origin absent and Referer is another site -> 403; absent both -> 403", async () => {
    expect((await exchange({ origin: null, referer: "https://evil.example/" })).status).toBe(403);
    expect((await exchange({ origin: null, referer: "https://evil.example/http://127.0.0.1:3131/" })).status).toBe(403);
    expect((await exchange({ origin: null })).status).toBe(403);
    expect((await exchange({ origin: null, referer: "not a url" })).status).toBe(403);
  });

  it("Origin absent and Referer same-origin -> passes the gate (400 from validation)", async () => {
    const res = await exchange({ origin: null, referer: "http://127.0.0.1:3131/settings" });
    expect(res.status).toBe(400);
    expect(await expectJson(res)).toEqual({ error: { code: "public_token_required" } });
  });

  it("correct Origin + header -> not 401/403 (400 from validation)", async () => {
    const res = await exchange({});
    expect(res.status).toBe(400);
  });

  it("the matrix holds on DELETE /api/items/:id, PATCH /api/transactions/:id and DELETE /api/data", async () => {
    const del = (opts: Parameters<typeof api>[1]) =>
      api("/api/items/no-such-item", { method: "DELETE", session, ...opts });
    expect((await del({ csrf: false })).status).toBe(403);
    expect((await del({ origin: "https://evil.example" })).status).toBe(403);
    expect((await del({})).status).toBe(404);

    const patch = (opts: Parameters<typeof api>[1]) =>
      api("/api/transactions/no-such-tx", { method: "PATCH", session, json: { bucket: "dining" }, ...opts });
    expect((await patch({ csrf: false })).status).toBe(403);
    expect((await patch({ origin: "https://evil.example" })).status).toBe(403);
    expect([400, 404]).toContain((await patch({})).status);

    const data = (opts: Parameters<typeof api>[1]) => api("/api/data", { method: "DELETE", session, ...opts });
    expect((await data({ csrf: false })).status).toBe(403);
    expect((await data({ origin: null, referer: "https://evil.example/" })).status).toBe(403);
  });

  it("auth routes without a session also enforce CSRF (logout, login, setup) and keep the session alive", async () => {
    const logout = await api("/api/auth/logout", { method: "POST", session, json: {}, csrf: false });
    expect(logout.status).toBe(403);
    expect((await api("/api/items", { session })).status).toBe(200);

    const login = await api("/api/auth/login/totp", { method: "POST", json: { code: "000000" }, origin: "https://evil.example" });
    expect(login.status).toBe(403);
    // With a factor enrolled the setup routes demand a session first (401), then CSRF (403).
    const setup = await api("/api/auth/setup/totp/start", { method: "POST", json: { setup_token: "x" }, csrf: false });
    expect(setup.status).toBe(401);
    const setupWithSession = await api("/api/auth/setup/totp/start", { method: "POST", session, json: {}, csrf: false });
    expect(setupWithSession.status).toBe(403);
    const sessions = await api("/api/auth/sessions", { method: "DELETE", session, csrf: false });
    expect(sessions.status).toBe(403);
    expect((await api("/api/items", { session })).status).toBe(200);
  });

  it("a cross-site simple form POST (no custom header, form content-type) is rejected", async () => {
    const res = await api("/api/plaid/exchange", {
      method: "POST",
      session,
      csrf: false,
      origin: "https://evil.example",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "public_token=abc",
    });
    expect(res.status).toBe(403);
  });
});
