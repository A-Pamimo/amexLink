import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { closeApp, loadApp } from "../helpers/app";
import { REQUIRED_ENV, makeReq, tokenFromResponse } from "../helpers/auth";

afterEach(() => closeApp());

const H = 3600 * 1000;
const D = 24 * H;
const T0 = Date.parse("2026-11-24T12:00:00.000Z");
const MOBILE = { "x-amexlens-client": "mobile" };
const CRON = "cron-secret-for-tests-0123456789abcdef";

/** A request as the native app sends it: no Origin, bearer token, custom headers only. */
function appReq(path: string, token: string | null, opts: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { ...MOBILE };
  if (token) headers.authorization = `Bearer ${token}`;
  return makeReq(path, { method: opts.method, body: opts.body, origin: null, headers });
}

async function enrolTotp() {
  const { db } = await loadApp({ ...REQUIRED_ENV, CRON_SECRET: CRON });
  const { encrypt } = await import("@/lib/crypto");
  const { TOTP_AAD, base32Encode, generateTotpSecret, stepAt, totpAt } = await import("@/lib/auth/totp");
  const { resetLockouts } = await import("@/lib/auth/lockout");
  resetLockouts();
  const secret = generateTotpSecret();
  await db.upsertAuthState({
    totp_secret_ct: encrypt(base32Encode(secret), TOTP_AAD),
    totp_confirmed_at: new Date().toISOString(),
    totp_last_step: null,
  });
  return { db, code: () => totpAt(secret, stepAt(Date.now())) };
}

describe("bearer sessions (native app)", () => {
  it("mobile TOTP sign-in returns the token in a header, sets no cookie, and stores a bearer row", async () => {
    const { db, code } = await enrolTotp();
    const { POST } = await import("@/app/api/auth/login/totp/route");
    const { sha256Hex } = await import("@/lib/crypto");

    const res = await POST(
      makeReq("/api/auth/login/totp", { method: "POST", body: { code: code() }, origin: null, headers: MOBILE })
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const token = res.headers.get("x-amexlens-session-token");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await res.json()).toEqual({ ok: true });
    const expires = Date.parse(res.headers.get("x-amexlens-session-expires")!);
    expect(expires - Date.now()).toBeGreaterThan(29 * D);

    const row = await db.getSession(sha256Hex(token!));
    expect(row?.kind).toBe("bearer");
  });

  it("browser sign-in is unchanged: cookie session, no token header", async () => {
    const { db, code } = await enrolTotp();
    const { POST } = await import("@/app/api/auth/login/totp/route");
    const { sha256Hex } = await import("@/lib/crypto");
    const res = await POST(makeReq("/api/auth/login/totp", { method: "POST", body: { code: code() } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-amexlens-session-token")).toBeNull();
    const token = tokenFromResponse(res);
    expect((await db.getSession(sha256Hex(token!)))?.kind).toBe("cookie");
  });

  it("mobile sign-in still needs X-AmexLens-Request; browser sign-in still needs Origin", async () => {
    const { code } = await enrolTotp();
    const { POST } = await import("@/app/api/auth/login/totp/route");
    const noHeader = await POST(
      makeReq("/api/auth/login/totp", {
        method: "POST",
        body: { code: code() },
        origin: null,
        csrfHeader: false,
        headers: MOBILE,
      })
    );
    expect(noHeader.status).toBe(403);
    // Only the exact value `mobile` counts; anything else is a browser request needing Origin.
    const wrongValue = await POST(
      makeReq("/api/auth/login/totp", {
        method: "POST",
        body: { code: code() },
        origin: null,
        headers: { "x-amexlens-client": "Mobile " },
      })
    );
    expect(wrongValue.status).toBe(403);
  });

  it("a bearer works for reads and for mutations without Origin", async () => {
    await loadApp(REQUIRED_ENV);
    const { createSession, requireSession } = await import("@/lib/auth/session");
    const { requireMutation } = await import("@/lib/auth/guard");
    const token = await createSession(Date.now(), "bearer");

    const r = await requireSession(appReq("/api/cards", token));
    expect(r.ok && r.session.transport).toBe("bearer");
    const m = await requireMutation(appReq("/api/items/x", token, { method: "DELETE" }));
    expect(m.ok).toBe(true);
    // A bearer from any origin, even a hostile one, is fine: the holder built the request.
    const hostile = makeReq("/x", {
      method: "POST",
      origin: "https://evil.example",
      csrfHeader: false,
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await requireMutation(hostile)).ok).toBe(true);
  });

  it("tokens only work on their own transport", async () => {
    await loadApp(REQUIRED_ENV);
    const { createSession, requireSession } = await import("@/lib/auth/session");
    const cookieTok = await createSession(Date.now(), "cookie");
    const bearerTok = await createSession(Date.now(), "bearer");

    expect((await requireSession(appReq("/api/cards", cookieTok))).ok).toBe(false);
    expect((await requireSession(makeReq("/api/cards", { token: bearerTok }))).ok).toBe(false);
    // Refusal on the wrong transport does not delete the row.
    expect((await requireSession(makeReq("/api/cards", { token: cookieTok }))).ok).toBe(true);
    expect((await requireSession(appReq("/api/cards", bearerTok))).ok).toBe(true);
  });

  it("an Authorization header is the only credential considered: junk bearer + good cookie → 401", async () => {
    await loadApp(REQUIRED_ENV);
    const { createSession, requireSession } = await import("@/lib/auth/session");
    const cookieTok = await createSession();
    for (const authorization of ["Bearer nope", "Basic Zm9vOmJhcg==", "Bearer", `Token ${cookieTok}`]) {
      const req = makeReq("/api/cards", { token: cookieTok, headers: { authorization } });
      const r = await requireSession(req);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status).toBe(401);
    }
  });

  it("a cookie session never skips CSRF, even when it claims to be the app", async () => {
    await loadApp(REQUIRED_ENV);
    const { createSession } = await import("@/lib/auth/session");
    const { requireMutation } = await import("@/lib/auth/guard");
    const token = await createSession();
    const r = await requireMutation(
      makeReq("/x", { method: "POST", token, origin: "https://evil.example", headers: MOBILE })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("bearer lifetimes: 7-day idle timeout, 30-day absolute", async () => {
    const { db } = await loadApp(REQUIRED_ENV);
    const { createSession, requireSession } = await import("@/lib/auth/session");
    const { sha256Hex } = await import("@/lib/crypto");

    const idle = await createSession(T0, "bearer");
    expect((await requireSession(appReq("/x", idle), { now: T0 + 6 * D })).ok).toBe(true);
    expect((await requireSession(appReq("/x", idle), { now: T0 + 13 * D + H })).ok).toBe(false);
    expect(await db.getSession(sha256Hex(idle))).toBeNull();

    const busy = await createSession(T0, "bearer");
    for (let d = 1; d < 30; d++) {
      expect((await requireSession(appReq("/x", busy), { now: T0 + d * D })).ok).toBe(true);
    }
    expect((await requireSession(appReq("/x", busy), { now: T0 + 30 * D })).ok).toBe(false);

    // A cookie session keeps its 2 h idle timeout.
    const cookieTok = await createSession(T0);
    expect((await requireSession(makeReq("/x", { token: cookieTok }), { now: T0 + 3 * H })).ok).toBe(false);
  });

  it("rotation after a sensitive action hands a new bearer back in the header and kills the old one", async () => {
    await loadApp(REQUIRED_ENV);
    const { createSession, requireSession, rotateSessionOnResponse } = await import("@/lib/auth/session");
    const old = await createSession(Date.now(), "bearer");
    const auth = await requireSession(appReq("/x", old));
    const res = new Response("{}");
    await rotateSessionOnResponse(auth, res);
    const fresh = res.headers.get("x-amexlens-session-token");
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh).not.toBe(old);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await requireSession(appReq("/x", old))).ok).toBe(false);
    expect((await requireSession(appReq("/x", fresh))).ok).toBe(true);
  });

  it("mobile re-sign-in with a presented bearer rotates it", async () => {
    const { code } = await enrolTotp();
    const { createSession, requireSession } = await import("@/lib/auth/session");
    const { POST } = await import("@/app/api/auth/login/totp/route");
    const old = await createSession(Date.now(), "bearer");
    const res = await POST(appReq("/api/auth/login/totp", old, { method: "POST", body: { code: code() } }));
    expect(res.status).toBe(200);
    expect((await requireSession(appReq("/x", old))).ok).toBe(false);
    expect((await requireSession(appReq("/x", res.headers.get("x-amexlens-session-token")))).ok).toBe(true);
  });

  it("logout with a bearer deletes that row, needs no Origin, and clears no cookie", async () => {
    await loadApp(REQUIRED_ENV);
    const { createSession, requireSession } = await import("@/lib/auth/session");
    const { POST } = await import("@/app/api/auth/logout/route");
    const token = await createSession(Date.now(), "bearer");
    const other = await createSession(Date.now(), "bearer");
    const res = await POST(appReq("/api/auth/logout", token, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await requireSession(appReq("/x", token))).ok).toBe(false);
    expect((await requireSession(appReq("/x", other))).ok).toBe(true);
  });

  it("sign out everywhere from the app kills browser and app sessions", async () => {
    await loadApp(REQUIRED_ENV);
    const { createSession, requireSession } = await import("@/lib/auth/session");
    const { DELETE } = await import("@/app/api/auth/sessions/route");
    const app = await createSession(Date.now(), "bearer");
    const browser = await createSession();
    const res = await DELETE(appReq("/api/auth/sessions", app, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect((await requireSession(appReq("/x", app))).ok).toBe(false);
    expect((await requireSession(makeReq("/x", { token: browser }))).ok).toBe(false);
  });
});

describe("authorizeSync with bearers", () => {
  const post = (authorization: string) =>
    new Request("http://localhost:3000/api/plaid/sync", { method: "POST", headers: { authorization } });

  it("CRON_SECRET → cron; app bearer → session; unknown token-shaped bearer → 401", async () => {
    await loadApp({ ...REQUIRED_ENV, CRON_SECRET: CRON });
    const { createSession } = await import("@/lib/auth/session");
    const { authorizeSync } = await import("@/lib/sync/authorize");
    const { randomToken } = await import("@/lib/crypto");
    expect(await authorizeSync(post(`Bearer ${CRON}`))).toEqual({ ok: true, via: "cron" });
    const app = await createSession(Date.now(), "bearer");
    expect(await authorizeSync(post(`Bearer ${app}`))).toEqual({ ok: true, via: "session" });
    const unknown = await authorizeSync(post(`Bearer ${randomToken(32)}`));
    expect(unknown.ok).toBe(false);
    const cookieTok = await createSession();
    expect((await authorizeSync(post(`Bearer ${cookieTok}`))).ok).toBe(false);
  });

  it("under AUTH_MODE=none a non-cron bearer is still 401, never the stand-in", async () => {
    await loadApp({ AUTH_MODE: "none", CRON_SECRET: CRON });
    const { authorizeSync } = await import("@/lib/sync/authorize");
    const r = await authorizeSync(post(`Bearer ${"A".repeat(43)}`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });
});

describe("middleware with bearers", () => {
  it("passes a session-shaped bearer on /api/* only; pages still redirect; junk bearers 401", async () => {
    const saved = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "required";
    try {
      const { middleware } = await import("@/middleware");
      const at = (path: string, authorization: string) =>
        middleware(new NextRequest(`http://localhost:3000${path}`, { headers: { authorization } }));
      const shaped = `Bearer ${"A".repeat(43)}`;
      const api = at("/api/cards", shaped);
      expect(api.status).toBe(200);
      expect(api.headers.get("x-middleware-next")).toBe("1");
      expect(at("/", shaped).status).toBe(307);
      expect(at("/api/cards", "Bearer short").status).toBe(401);
      expect(at("/api/cards", `Basic ${"A".repeat(43)}`).status).toBe(401);
    } finally {
      if (saved === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = saved;
    }
  });
});
