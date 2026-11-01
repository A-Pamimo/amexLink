import { afterEach, describe, expect, it, vi } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { ORIGIN, REQUIRED_ENV, SETUP_TOKEN, makeReq, tokenFromResponse } from "../helpers/auth";

/**
 * @simplewebauthn/server is mocked: these tests cover OUR state machine
 * (challenge storage, single use, TTL, rpID/origin wiring, counter regression,
 * setup gating), not the WebAuthn cryptography itself.
 */
let counter = 0;
vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: vi.fn(async (o: { rpID: string; rpName: string }) => ({
    challenge: `reg-${++counter}`,
    rp: { id: o.rpID, name: o.rpName },
    user: { id: "u", name: "owner", displayName: "owner" },
    pubKeyCredParams: [],
  })),
  verifyRegistrationResponse: vi.fn(async () => ({
    verified: true,
    registrationInfo: {
      fmt: "none",
      aaguid: "00000000-0000-0000-0000-000000000000",
      credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
      credentialType: "public-key",
      attestationObject: new Uint8Array(),
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: "http://localhost:3000",
    },
  })),
  generateAuthenticationOptions: vi.fn(async (o: { rpID: string }) => ({
    challenge: `auth-${++counter}`,
    rpId: o.rpID,
  })),
  verifyAuthenticationResponse: vi.fn(async (o: { credential: { id: string; counter: number } }) => ({
    verified: true,
    authenticationInfo: {
      credentialID: o.credential.id,
      newCounter: o.credential.counter + 1,
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: "http://localhost:3000",
      rpID: "localhost",
    },
  })),
}));

afterEach(() => closeApp());

const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const FIVE_MIN = 5 * 60 * 1000;

async function swa() {
  return vi.mocked(await import("@simplewebauthn/server"));
}

describe("passkey state machine", () => {
  it("registration: rpID/rpName/origin wired from APP_ORIGIN, challenge single-use", async () => {
    await loadApp(REQUIRED_ENV);
    const lib = await import("@/lib/auth/passkey");
    const mock = await swa();

    const start = await lib.beginRegistration(T0);
    expect(mock.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: "localhost",
        rpName: "AmexLens",
        attestationType: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      })
    );
    expect(start.options.challenge).toBe("reg-1");

    const ok = await lib.finishRegistration({
      challenge_id: start.challenge_id,
      response: { id: "cred-1" },
      label: "laptop",
      now: T0 + 1000,
    });
    expect(ok).toEqual({ ok: true, id: "cred-1" });
    expect(mock.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: "reg-1",
        expectedOrigin: ORIGIN,
        expectedRPID: "localhost",
        requireUserVerification: true,
      })
    );

    // same challenge again → rejected before the library is consulted
    mock.verifyRegistrationResponse.mockClear();
    const replay = await lib.finishRegistration({
      challenge_id: start.challenge_id,
      response: { id: "cred-1" },
      now: T0 + 2000,
    });
    expect(replay).toEqual({ ok: false, reason: "challenge" });
    expect(mock.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it("challenges expire after 5 minutes", async () => {
    await loadApp(REQUIRED_ENV);
    const lib = await import("@/lib/auth/passkey");
    const start = await lib.beginRegistration(T0);
    const late = await lib.finishRegistration({
      challenge_id: start.challenge_id,
      response: { id: "cred-1" },
      now: T0 + FIVE_MIN + 1,
    });
    expect(late).toEqual({ ok: false, reason: "challenge" });

    const start2 = await lib.beginAuthentication(T0);
    const late2 = await lib.finishAuthentication({
      challenge_id: start2.challenge_id,
      response: { id: "cred-1" },
      now: T0 + FIVE_MIN + 1,
    });
    expect(late2).toEqual({ ok: false, reason: "challenge" });
  });

  it("a registration challenge cannot be used for authentication (and vice versa)", async () => {
    await loadApp(REQUIRED_ENV);
    const lib = await import("@/lib/auth/passkey");
    const reg = await lib.beginRegistration(T0);
    expect(
      await lib.finishAuthentication({ challenge_id: reg.challenge_id, response: { id: "cred-1" }, now: T0 })
    ).toEqual({ ok: false, reason: "challenge" });
  });

  it("authentication: counter must increase; regression is rejected and not persisted", async () => {
    const { db } = await loadApp(REQUIRED_ENV);
    const lib = await import("@/lib/auth/passkey");
    const mock = await swa();
    await db.insertPasskey({
      id: "cred-1",
      public_key: Buffer.from([1, 2, 3]),
      counter: 5,
      transports: ["internal"],
      device_type: "multiDevice",
      backed_up: true,
      label: null,
    });

    const s1 = await lib.beginAuthentication(T0);
    expect(mock.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: "localhost",
        userVerification: "required",
        allowCredentials: [{ id: "cred-1", transports: ["internal"] }],
      })
    );
    mock.verifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-1",
        newCounter: 3,
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: ORIGIN,
        rpID: "localhost",
      },
    });
    const regressed = await lib.finishAuthentication({
      challenge_id: s1.challenge_id,
      response: { id: "cred-1" },
      now: T0,
    });
    expect(regressed).toEqual({ ok: false, reason: "counter_regression" });
    expect((await db.getPasskey("cred-1"))!.counter).toBe(5);

    const s2 = await lib.beginAuthentication(T0);
    const fine = await lib.finishAuthentication({
      challenge_id: s2.challenge_id,
      response: { id: "cred-1" },
      now: T0,
    });
    expect(fine).toEqual({ ok: true, id: "cred-1" });
    expect(mock.verifyAuthenticationResponse).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedOrigin: ORIGIN,
        expectedRPID: "localhost",
        requireUserVerification: true,
        credential: expect.objectContaining({ id: "cred-1", counter: 5 }),
      })
    );
    expect((await db.getPasskey("cred-1"))!.counter).toBe(6);

    // unknown credential id
    const s3 = await lib.beginAuthentication(T0);
    expect(
      await lib.finishAuthentication({ challenge_id: s3.challenge_id, response: { id: "nope" }, now: T0 })
    ).toEqual({ ok: false, reason: "unknown_credential" });
  });

  it("first-factor registration needs the setup token; a second passkey needs a session", async () => {
    await loadApp(REQUIRED_ENV);
    const options = (await import("@/app/api/auth/setup/passkey/options/route")).POST;
    const verify = (await import("@/app/api/auth/setup/passkey/verify/route")).POST;
    const { requireSession } = await import("@/lib/auth/session");

    // zero factors: no token → 401, wrong token → 401, right token → 200
    expect((await options(makeReq("/o", { method: "POST", body: {} }))).status).toBe(401);
    const wrong = await options(makeReq("/o", { method: "POST", body: { setup_token: "x".repeat(32) } }));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: { code: "invalid_setup_token" } });
    // right token but no CSRF header → 403
    expect(
      (await options(makeReq("/o", { method: "POST", body: { setup_token: SETUP_TOKEN }, csrfHeader: false })))
        .status
    ).toBe(403);

    const started = await options(makeReq("/o", { method: "POST", body: { setup_token: SETUP_TOKEN } }));
    expect(started.status).toBe(200);
    const { challenge_id } = (await started.json()) as { challenge_id: string };

    const done = await verify(
      makeReq("/v", {
        method: "POST",
        body: { setup_token: SETUP_TOKEN, challenge_id, response: { id: "cred-1" }, label: "key" },
      })
    );
    expect(done.status).toBe(200);
    const token = tokenFromResponse(done);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // first factor → signed in
    expect((await requireSession(makeReq("/x", { token }))).ok).toBe(true);

    // a factor now exists: the setup token is dead, a session is required
    const dead = await options(makeReq("/o", { method: "POST", body: { setup_token: SETUP_TOKEN } }));
    expect(dead.status).toBe(401);
    expect(await dead.json()).toEqual({ error: { code: "unauthenticated" } });

    const second = await options(makeReq("/o", { method: "POST", body: {}, token }));
    expect(second.status).toBe(200);
    const { challenge_id: c2 } = (await second.json()) as { challenge_id: string };
    const mock = await swa();
    mock.verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        fmt: "none",
        aaguid: "00000000-0000-0000-0000-000000000000",
        credential: { id: "cred-2", publicKey: new Uint8Array([4]), counter: 0 },
        credentialType: "public-key",
        attestationObject: new Uint8Array(),
        userVerified: true,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        origin: ORIGIN,
      },
    });
    const done2 = await verify(
      makeReq("/v", { method: "POST", token, body: { challenge_id: c2, response: { id: "cred-2" } } })
    );
    expect(done2.status).toBe(200);
    expect(tokenFromResponse(done2)).toBeNull(); // not the first factor: no new cookie

    const statusRoute = (await import("@/app/api/auth/status/route")).GET;
    const status = await statusRoute(makeReq("/api/auth/status", { token }));
    expect(await status.json()).toEqual({
      mode: "required",
      setup_required: false,
      factors: { totp: false, passkeys: 2, recovery_codes_remaining: 0 },
    });
    // Anonymous callers learn which factors exist, not how many recovery codes are left.
    const anon = await statusRoute(makeReq("/api/auth/status"));
    expect((await anon.json()).factors).toEqual({ totp: false, passkeys: 2, recovery_codes_remaining: null });
  });

  it("login via passkey sets the cookie; a rejected assertion is counted and returns invalid_code", async () => {
    const { db } = await loadApp(REQUIRED_ENV);
    await db.insertPasskey({
      id: "cred-1",
      public_key: Buffer.from([1, 2, 3]),
      counter: 0,
      transports: null,
      device_type: null,
      backed_up: null,
      label: null,
    });
    const options = (await import("@/app/api/auth/login/passkey/options/route")).POST;
    const verify = (await import("@/app/api/auth/login/passkey/verify/route")).POST;

    const o = await options(makeReq("/o", { method: "POST", body: {} }));
    expect(o.status).toBe(200);
    const { challenge_id } = (await o.json()) as { challenge_id: string };
    const v = await verify(makeReq("/v", { method: "POST", body: { challenge_id, response: { id: "cred-1" } } }));
    expect(v.status).toBe(200);
    expect(tokenFromResponse(v)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const bad = await verify(makeReq("/v", { method: "POST", body: { challenge_id, response: { id: "cred-1" } } }));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: { code: "invalid_code" } });
  });
});
