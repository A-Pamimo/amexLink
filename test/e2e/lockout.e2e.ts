import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stepAt } from "@/lib/auth/totp";
import { codeFor, headersFor, seedTotp, wrongCode } from "./helpers/client";
import { makeConfig, startServer, stopServer, type RunningServer } from "./helpers/server";

/**
 * Lockout runs against its own server processes: a lock lasts 15 minutes and would block every
 * other file's logins on the shared server. The main server is untouched.
 */

function post(origin: string, p: string, json: unknown, extra: Record<string, string> = {}) {
  return fetch(origin + p, {
    method: "POST",
    headers: headersFor(origin, { method: "POST", json, headers: extra }),
    body: JSON.stringify(json),
  });
}

describe("login lockout (own server)", () => {
  let dir: string;
  let server: RunningServer;
  let secret: string;
  let lastStep: number;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "amexlens-e2e-lock-"));
    server = await startServer(makeConfig(3132, dir));
    const seeded = await seedTotp(server);
    secret = seeded.secret;
    lastStep = seeded.lastStep;
  });
  afterAll(async () => {
    if (server) await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("5 wrong codes with rotating X-Forwarded-For -> the 6th is 429 with Retry-After; a correct code is 429 too", async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await post(server.origin, "/api/auth/login/totp", { code: wrongCode(secret) }, {
        "x-forwarded-for": `203.0.113.${i}`,
        "x-real-ip": `198.51.100.${i}`,
        forwarded: `for=192.0.2.${i}`,
      });
      expect(res.status, `attempt ${i}`).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "invalid_code" } });
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    const sixth = await post(server.origin, "/api/auth/login/totp", { code: wrongCode(secret) }, {
      "x-forwarded-for": "203.0.113.6",
    });
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ error: { code: "locked_out" } });
    const retry = Number(sixth.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(15 * 60);

    // A valid, never-used code is refused while locked.
    const step = Math.max(stepAt(Date.now()), lastStep + 1);
    const good = await post(server.origin, "/api/auth/login/totp", { code: codeFor(secret, step) }, {
      "x-forwarded-for": "203.0.113.77",
    });
    expect(good.status).toBe(429);
    expect(good.headers.getSetCookie()).toEqual([]);

    // The lock covers every first-factor path, not only TOTP.
    expect((await post(server.origin, "/api/auth/login/recovery", { code: "aaaaa-aaaaa" })).status).toBe(429);
    expect((await post(server.origin, "/api/auth/login/passkey/options", {})).status).toBe(429);
    expect((await post(server.origin, "/api/auth/login/passkey/verify", { challenge_id: "x", response: {} })).status).toBe(429);

    // Unrelated public endpoints keep working.
    expect((await fetch(server.origin + "/api/health")).status).toBe(200);
    expect((await fetch(server.origin + "/api/auth/status")).status).toBe(200);
  });
});

describe("setup-token lockout (own server, no factor enrolled)", () => {
  let dir: string;
  let server: RunningServer;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "amexlens-e2e-setup-"));
    server = await startServer(makeConfig(3133, dir));
  });
  afterAll(async () => {
    if (server) await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("5 wrong setup tokens lock the bootstrap; the right token is then 429", async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await post(server.origin, "/api/auth/setup/totp/start", { setup_token: `wrong-${i}-`.padEnd(40, "x") }, {
        "x-forwarded-for": `203.0.113.${i}`,
      });
      expect(res.status, `attempt ${i}`).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "invalid_setup_token" } });
    }
    const sixth = await post(server.origin, "/api/auth/setup/totp/start", { setup_token: "wrong-6".padEnd(40, "x") });
    expect(sixth.status).toBe(429);
    const right = await post(server.origin, "/api/auth/setup/totp/start", { setup_token: server.setupToken });
    expect(right.status).toBe(429);
    const passkey = await post(server.origin, "/api/auth/setup/passkey/options", { setup_token: server.setupToken });
    expect(passkey.status).toBe(429);
  });

  it("a short or non-string token never compares equal", async () => {
    for (const setup_token of ["", null, 1, {}, server.setupToken.slice(0, -1)]) {
      const res = await post(server.origin, "/api/auth/setup/totp/start", { setup_token });
      expect([401, 429]).toContain(res.status);
    }
  });
});
