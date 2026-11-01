import { afterEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { REQUIRED_ENV, makeReq, setCookieHeaders, tokenFromResponse } from "../helpers/auth";

afterEach(() => closeApp());

const H = 3600 * 1000;
const T0 = Date.parse("2026-10-31T12:00:00.000Z");

async function sessionLib() {
  return import("@/lib/auth/session");
}

describe("sessions", () => {
  it("stores only sha256(token) and accepts the raw token from the cookie", async () => {
    const { db } = await loadApp(REQUIRED_ENV);
    const { createSession, requireSession } = await sessionLib();
    const { sha256Hex } = await import("@/lib/crypto");
    const raw = await createSession(T0);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await db.getSession(raw)).toBeNull();
    expect(await db.getSession(sha256Hex(raw))).not.toBeNull();

    const r = await requireSession(makeReq("/api/items", { token: raw }), { now: T0 + 1000 });
    expect(r.ok).toBe(true);
  });

  it("rejects missing, malformed and unknown tokens with 401 JSON", async () => {
    await loadApp(REQUIRED_ENV);
    const { requireSession } = await sessionLib();
    const { randomToken } = await import("@/lib/crypto");
    for (const req of [
      makeReq("/api/items"),
      makeReq("/api/items", { cookie: "__Host-amexlens_session=ok" }),
      makeReq("/api/items", { cookie: "amexlens_auth=ok" }),
      makeReq("/api/items", { token: randomToken(32) }),
    ]) {
      const r = await requireSession(req, { now: T0 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(401);
        expect(r.response.headers.get("cache-control")).toBe("no-store");
        expect(await r.response.json()).toEqual({ error: { code: "unauthenticated" } });
      }
    }
  });

  it("enforces the 2h idle timeout and touches last_seen_at at most once a minute", async () => {
    const { db } = await loadApp(REQUIRED_ENV);
    const { createSession, requireSession } = await sessionLib();
    const { sha256Hex } = await import("@/lib/crypto");
    const raw = await createSession(T0);
    const req = () => makeReq("/api/items", { token: raw });

    // 30s later: alive, but not touched yet.
    expect((await requireSession(req(), { now: T0 + 30_000 })).ok).toBe(true);
    expect((await db.getSession(sha256Hex(raw)))!.last_seen_at).toBe(new Date(T0).toISOString());
    // 1h later: alive and touched.
    expect((await requireSession(req(), { now: T0 + H })).ok).toBe(true);
    expect((await db.getSession(sha256Hex(raw)))!.last_seen_at).toBe(new Date(T0 + H).toISOString());
    // 1h59 after that touch: alive.
    expect((await requireSession(req(), { now: T0 + H + 2 * H - 60_000 })).ok).toBe(true);
    // Now idle for 2h+1s since the last touch: dead, row deleted.
    const r = await requireSession(req(), { now: T0 + 3 * H - 60_000 + 2 * H + 1000 });
    expect(r.ok).toBe(false);
    expect(await db.getSession(sha256Hex(raw))).toBeNull();
  });

  it("enforces the 12h absolute lifetime even with constant activity", async () => {
    await loadApp(REQUIRED_ENV);
    const { createSession, requireSession } = await sessionLib();
    const raw = await createSession(T0);
    for (let h = 1; h < 12; h++) {
      expect((await requireSession(makeReq("/x", { token: raw }), { now: T0 + h * H })).ok).toBe(true);
    }
    const r = await requireSession(makeReq("/x", { token: raw }), { now: T0 + 12 * H });
    expect(r.ok).toBe(false);
  });

  it("logout deletes the row so a second copy of the cookie stops working", async () => {
    await loadApp(REQUIRED_ENV);
    const { createSession, requireSession } = await sessionLib();
    const { POST } = await import("@/app/api/auth/logout/route");
    const raw = await createSession();
    const copy = raw; // the same cookie in another browser

    const res = await POST(makeReq("/api/auth/logout", { method: "POST", token: raw, body: {} }));
    expect(res.status).toBe(200);
    expect(setCookieHeaders(res).some((c) => /__Host-amexlens_session=;.*Max-Age=0/.test(c))).toBe(true);

    expect((await requireSession(makeReq("/x", { token: copy }))).ok).toBe(false);
  });

  it("rotateSession invalidates the old token and issues a fresh one", async () => {
    await loadApp(REQUIRED_ENV);
    const { createSession, requireSession, rotateSession } = await sessionLib();
    const old = await createSession();
    const fresh = await rotateSession(old);
    expect(fresh).not.toBe(old);
    expect((await requireSession(makeReq("/x", { token: old }))).ok).toBe(false);
    expect((await requireSession(makeReq("/x", { token: fresh }))).ok).toBe(true);
  });

  it("DELETE /api/auth/sessions destroys every session", async () => {
    await loadApp(REQUIRED_ENV);
    const { createSession, requireSession } = await sessionLib();
    const { DELETE } = await import("@/app/api/auth/sessions/route");
    const a = await createSession();
    const b = await createSession();
    const res = await DELETE(makeReq("/api/auth/sessions", { method: "DELETE", token: a }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 2 });
    expect((await requireSession(makeReq("/x", { token: a }))).ok).toBe(false);
    expect((await requireSession(makeReq("/x", { token: b }))).ok).toBe(false);
  });

  it("sets a __Host- cookie with Secure, HttpOnly, SameSite=Lax, Path=/, 12h Max-Age", async () => {
    await loadApp(REQUIRED_ENV);
    const { setSessionCookie } = await sessionLib();
    const res = new Response(null);
    setSessionCookie(res, "a".repeat(43));
    const cookies = setCookieHeaders(res);
    expect(cookies).toHaveLength(1);
    const c = cookies[0];
    expect(c.startsWith("__Host-amexlens_session=" + "a".repeat(43))).toBe(true);
    for (const flag of ["Path=/", "Max-Age=43200", "HttpOnly", "SameSite=Lax", "Secure"]) {
      expect(c).toContain(flag);
    }
    expect(c).not.toMatch(/Domain=/);
    expect(tokenFromResponse(res)).toBe("a".repeat(43));
  });

  it("COOKIE_INSECURE_DEV=1 drops the __Host- prefix and the Secure flag", async () => {
    await loadApp({ ...REQUIRED_ENV, COOKIE_INSECURE_DEV: "1" });
    const { setSessionCookie, requireSession, createSession } = await sessionLib();
    const res = new Response(null);
    setSessionCookie(res, "b".repeat(43));
    const c = setCookieHeaders(res)[0];
    expect(c.startsWith("amexlens_session=")).toBe(true);
    expect(c).not.toContain("Secure");
    expect(c).toContain("HttpOnly");
    const raw = await createSession();
    const ok = await requireSession(makeReq("/x", { cookie: `amexlens_session=${raw}` }));
    expect(ok.ok).toBe(true);
  });

  it("AUTH_MODE=none yields a synthetic session without touching the DB", async () => {
    await loadApp({ AUTH_MODE: "none" });
    const { requireSession } = await sessionLib();
    const r = await requireSession(makeReq("/api/items"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.synthetic).toBe(true);
  });
});
