import { afterEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { REQUIRED_ENV, makeReq, tokenFromResponse } from "../helpers/auth";

afterEach(() => closeApp());

describe("login lockout", () => {
  it("unit: 5 failures in 15 minutes → locked for 15 minutes; success resets", async () => {
    const { checkLockout, recordFailure, recordSuccess, resetLockouts } = await import(
      "@/lib/auth/lockout"
    );
    resetLockouts();
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) recordFailure("login", t0 + i * 1000);
    expect(checkLockout("login", t0 + 5000)).toBeNull();
    recordFailure("login", t0 + 5000);
    const locked = checkLockout("login", t0 + 6000);
    expect(locked?.status).toBe(429);
    expect(Number(locked?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await locked?.json()).toEqual({ error: { code: "locked_out" } });
    // still locked at 14:59 after the lock, free at 15:00
    expect(checkLockout("login", t0 + 5000 + 15 * 60 * 1000 - 1)?.status).toBe(429);
    expect(checkLockout("login", t0 + 5000 + 15 * 60 * 1000)).toBeNull();

    // failures spread over more than 15 minutes do not accumulate
    resetLockouts();
    for (let i = 0; i < 10; i++) recordFailure("login", t0 + i * 4 * 60 * 1000);
    expect(checkLockout("login", t0 + 40 * 60 * 1000)).toBeNull();

    // success clears the counter
    resetLockouts();
    for (let i = 0; i < 4; i++) recordFailure("login", t0);
    recordSuccess("login");
    recordFailure("login", t0);
    expect(checkLockout("login", t0)).toBeNull();
    resetLockouts();
  });

  it("route: 5 bad TOTP codes → 429, regardless of X-Forwarded-For; a good code resets", async () => {
    const { db } = await loadApp(REQUIRED_ENV);
    const { resetLockouts } = await import("@/lib/auth/lockout");
    const { encrypt } = await import("@/lib/crypto");
    const { TOTP_AAD, base32Encode, generateTotpSecret, stepAt, totpAt } = await import("@/lib/auth/totp");
    const { POST } = await import("@/app/api/auth/login/totp/route");
    resetLockouts();

    const secret = generateTotpSecret();
    await db.upsertAuthState({
      totp_secret_ct: encrypt(base32Encode(secret), TOTP_AAD),
      totp_confirmed_at: new Date().toISOString(),
      totp_last_step: null,
    });

    const attempt = (code: string, ip: string) =>
      POST(makeReq("/api/auth/login/totp", { method: "POST", body: { code }, headers: { "x-forwarded-for": ip } }));

    // 4 failures from "different clients" then a success: counter resets.
    for (let i = 0; i < 4; i++) expect((await attempt("000000", `10.0.0.${i}`)).status).toBe(401);
    const good = await attempt(totpAt(secret, stepAt(Date.now())), "10.0.0.99");
    expect(good.status).toBe(200);
    expect(tokenFromResponse(good)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    for (let i = 0; i < 5; i++) {
      const r = await attempt("000000", `203.0.113.${i}`);
      expect(r.status, `attempt ${i + 1}`).toBe(401);
      expect(await r.json()).toEqual({ error: { code: "invalid_code" } });
    }
    const locked = await attempt("000000", "198.51.100.1");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await locked.json()).toEqual({ error: { code: "locked_out" } });

    // even the right code is refused while locked (and the lock covers every login route)
    const next = totpAt(secret, stepAt(Date.now()) + 1);
    expect((await attempt(next, "198.51.100.2")).status).toBe(429);
    const recovery = (await import("@/app/api/auth/login/recovery/route")).POST;
    expect(
      (await recovery(makeReq("/api/auth/login/recovery", { method: "POST", body: { code: "aaaaa-aaaaa" } }))).status
    ).toBe(429);
    resetLockouts();
  });

  it("the setup token has its own lockout scope", async () => {
    await loadApp(REQUIRED_ENV);
    const { resetLockouts } = await import("@/lib/auth/lockout");
    const { POST } = await import("@/app/api/auth/setup/totp/start/route");
    resetLockouts();
    for (let i = 0; i < 5; i++) {
      const r = await POST(makeReq("/s", { method: "POST", body: { setup_token: `wrong-${i}`.padEnd(32, "x") } }));
      expect(r.status).toBe(401);
    }
    const r = await POST(makeReq("/s", { method: "POST", body: { setup_token: "x".repeat(32) } }));
    expect(r.status).toBe(429);
    resetLockouts();
  });
});
