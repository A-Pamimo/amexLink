import { describe, expect, it } from "vitest";
import { api, COOKIE, cookieFrom, e2e, expectJson, mintSession, readState, reserveTotpCode } from "./helpers/client";

describe("sessions over HTTP", () => {
  it("login sets a 43-char HttpOnly Lax cookie with a 12 h Max-Age; a copy works until logout", async () => {
    const code = await reserveTotpCode(e2e().stateFile, { wait: true });
    const res = await api("/api/auth/login/totp", { method: "POST", json: { code } });
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toMatch(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax$`));
    const token = cookieFrom(res)!;
    expect(await expectJson(res)).toEqual({ ok: true });

    // Two "browsers" holding the same cookie value.
    expect((await api("/api/items", { session: token })).status).toBe(200);
    expect((await api("/api/items", { session: token })).status).toBe(200);

    const logout = await api("/api/auth/logout", { method: "POST", session: token, json: {} });
    expect(logout.status).toBe(200);
    expect(logout.headers.getSetCookie()[0]).toMatch(new RegExp(`^${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax$`));
    // The second copy is dead too: the row is gone.
    const after = await api("/api/items", { session: token });
    expect(after.status).toBe(401);
    expect(await expectJson(after)).toEqual({ error: { code: "unauthenticated" } });
  });

  it("the same TOTP code is rejected on replay", async () => {
    const code = await reserveTotpCode(e2e().stateFile, { wait: true });
    const first = await api("/api/auth/login/totp", { method: "POST", json: { code } });
    expect(first.status).toBe(200);
    const replay = await api("/api/auth/login/totp", { method: "POST", json: { code } });
    expect(replay.status).toBe(401);
    expect(await expectJson(replay)).toEqual({ error: { code: "invalid_code" } });
    expect(replay.headers.getSetCookie()).toEqual([]);
  });

  it("logging in while presenting a session rotates it: the old token dies", async () => {
    const old = await mintSession();
    expect((await api("/api/items", { session: old })).status).toBe(200);
    const fresh = await mintSession({ presenting: old });
    expect(fresh).not.toBe(old);
    expect((await api("/api/items", { session: old })).status).toBe(401);
    expect((await api("/api/items", { session: fresh })).status).toBe(200);
  });

  it("DELETE /api/auth/sessions kills every session, including other browsers'", async () => {
    const a = await mintSession();
    const b = await mintSession();
    expect((await api("/api/items", { session: b })).status).toBe(200);
    const res = await api("/api/auth/sessions", { method: "DELETE", session: a });
    expect(res.status).toBe(200);
    const body = await expectJson<{ ok: boolean; deleted: number }>(res);
    expect(body.ok).toBe(true);
    expect(body.deleted).toBeGreaterThanOrEqual(2);
    expect((await api("/api/items", { session: a })).status).toBe(401);
    expect((await api("/api/items", { session: b })).status).toBe(401);
  });

  it("a recovery code works once and is reported as consumed", async () => {
    const { stateFile } = e2e();
    const code = readState(stateFile).recovery[0];
    expect(code).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    const res = await api("/api/auth/login/recovery", { method: "POST", json: { code: code.toUpperCase() } });
    expect(res.status).toBe(200);
    const body = await expectJson<{ ok: boolean; recovery_codes_remaining: number }>(res);
    expect(body.ok).toBe(true);
    const again = await api("/api/auth/login/recovery", { method: "POST", json: { code } });
    expect(again.status).toBe(401);
    // Keep the shared pool honest: that code is spent.
    const s = readState(stateFile);
    s.recovery = s.recovery.filter((c) => c !== code);
    const fs = await import("node:fs");
    fs.writeFileSync(stateFile, JSON.stringify(s));
    expect(body.recovery_codes_remaining).toBe(s.recovery.length);
  });

  it("/api/auth/status exposes factor presence but not the recovery-code count to anonymous callers", async () => {
    const anon = await expectJson<{ setup_required: boolean; factors: Record<string, unknown> }>(await api("/api/auth/status"));
    expect(anon.setup_required).toBe(false);
    expect(anon.factors.totp).toBe(true);
    expect(anon.factors.recovery_codes_remaining).toBeNull();
    const session = await mintSession();
    const auth = await expectJson<{ factors: Record<string, unknown> }>(await api("/api/auth/status", { session }));
    expect(typeof auth.factors.recovery_codes_remaining).toBe("number");
  });
});
