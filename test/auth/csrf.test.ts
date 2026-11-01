import { afterEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { ORIGIN, REQUIRED_ENV, makeReq } from "../helpers/auth";

afterEach(() => closeApp());

/** POST /api/auth/setup/recovery is a plain `requireMutation` route: 200 with a session + CSRF. */
async function call(opts: Parameters<typeof makeReq>[1]) {
  const { POST } = await import("@/app/api/auth/setup/recovery/route");
  return POST(makeReq("/api/auth/setup/recovery", { method: "POST", body: {}, ...opts }));
}

describe("CSRF guard (requireMutation / assertSameOrigin)", () => {
  it("matrix: header + origin → 200; missing header → 403; wrong origin → 403; nothing → 403", async () => {
    await loadApp(REQUIRED_ENV);
    const { createSession } = await import("@/lib/auth/session");
    const token = await createSession();

    const ok = await call({ token });
    expect(ok.status).toBe(200);

    const noHeader = await call({ token, csrfHeader: false });
    expect(noHeader.status).toBe(403);
    expect(await noHeader.json()).toEqual({ error: { code: "csrf" } });

    const wrongOrigin = await call({ token, origin: "https://evil.example" });
    expect(wrongOrigin.status).toBe(403);

    const nullOrigin = await call({ token, origin: "null" });
    expect(nullOrigin.status).toBe(403);

    const nothing = await call({ token, origin: null, csrfHeader: false });
    expect(nothing.status).toBe(403);

    // Origin absent, Referer from the app origin → accepted; foreign Referer → 403.
    const refererOk = await call({ token, origin: null, referer: `${ORIGIN}/settings?x=1` });
    expect(refererOk.status).toBe(200);
    const refererBad = await call({ token, origin: null, referer: "https://evil.example/settings" });
    expect(refererBad.status).toBe(403);
    const noneAtAll = await call({ token, origin: null });
    expect(noneAtAll.status).toBe(403);
  });

  it("checks the session before CSRF: no cookie → 401 even with the right headers", async () => {
    await loadApp(REQUIRED_ENV);
    const res = await call({});
    expect(res.status).toBe(401);
  });

  it("a prefix match of APP_ORIGIN is not a match", async () => {
    await loadApp(REQUIRED_ENV);
    const { createSession } = await import("@/lib/auth/session");
    const token = await createSession();
    expect((await call({ token, origin: `${ORIGIN}.evil.example` })).status).toBe(403);
    expect((await call({ token, origin: "http://localhost:30000" })).status).toBe(403);
    expect((await call({ token, origin: "https://localhost:3000" })).status).toBe(403);
  });

  it("assertSameOrigin can be used alone (login routes)", async () => {
    await loadApp(REQUIRED_ENV);
    const { assertSameOrigin, assertCsrf } = await import("@/lib/auth/guard");
    expect(assertSameOrigin(makeReq("/x", { method: "POST" }))).toBeNull();
    expect(assertSameOrigin(makeReq("/x", { method: "POST", origin: "https://evil.example" }))?.status).toBe(403);
    expect(assertCsrf(makeReq("/x", { method: "POST", csrfHeader: false }))?.status).toBe(403);
  });

  it("is skipped entirely under AUTH_MODE=none", async () => {
    await loadApp({ AUTH_MODE: "none" });
    const res = await call({ origin: null, csrfHeader: false });
    expect(res.status).toBe(200);
  });
});
