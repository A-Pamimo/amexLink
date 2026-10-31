import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { makeReq, ORIGIN, REQUIRED_ENV } from "../helpers/auth";
import { installPlaidFake } from "../helpers/plaid-fake";

/**
 * Regression tests for the WP9 red-team fixes (docs/RED-TEAM.md, findings RT-01..RT-08).
 * The over-the-wire versions live in test/e2e; these pin the behaviour at the unit level.
 */

const MiB = 1024 * 1024;

beforeEach(async () => {
  const { resetRateLimits } = await import("@/lib/http/rate-limit");
  resetRateLimits();
});
afterEach(() => {
  vi.restoreAllMocks();
  closeApp();
});

function bigJson(key: string, bytes: number): string {
  return JSON.stringify({ [key]: "x".repeat(bytes) });
}

function streamOf(text: string, chunk = 16 * 1024): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunk));
      offset += chunk;
    },
  });
}

describe("RT-01 request bodies are capped (lib/http/body.ts)", () => {
  it("readJsonBody: Content-Length over the cap is refused before reading; streams are cut off", async () => {
    const { readJsonBody, MAX_JSON_BODY_BYTES } = await import("@/lib/http/body");
    expect(MAX_JSON_BODY_BYTES).toBe(64 * 1024);

    const declared = new Request("http://x/", {
      method: "POST",
      headers: { "content-length": String(MiB), "content-type": "application/json" },
      body: "{}",
    });
    const r1 = await readJsonBody(declared);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.code).toBe("payload_too_large");
      expect(r1.response.status).toBe(413);
      expect(await r1.response.json()).toEqual({ error: { code: "payload_too_large" } });
      expect(r1.response.headers.get("cache-control")).toBe("no-store");
    }

    // Chunked (no Content-Length): must stop reading once past the cap, not buffer 4 MiB.
    let pulled = 0;
    const bytes = new TextEncoder().encode(bigJson("code", 4 * MiB));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(pulled, pulled + 8192));
        pulled += 8192;
      },
    });
    const chunked = new Request("http://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    const r2 = await readJsonBody(chunked);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.response.status).toBe(413);
    expect(pulled).toBeLessThan(MiB);

    const small = new Request("http://x/", {
      method: "POST",
      body: streamOf(JSON.stringify({ a: 1 }), 1),
      duplex: "half",
    } as RequestInit);
    expect(await readJsonBody(small)).toEqual({ ok: true, value: { a: 1 } });
    const empty = await readJsonBody(new Request("http://x/", { method: "POST", body: "" }));
    expect(empty).toEqual({ ok: true, value: undefined });
    const bad = await readJsonBody(new Request("http://x/", { method: "POST", body: "{nope" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.response.status).toBe(400);
  });

  it("POST /api/auth/login/totp with a 1 MiB body -> 413 and no lockout failure is recorded", async () => {
    await loadApp(REQUIRED_ENV);
    const { POST } = await import("@/app/api/auth/login/totp/route");
    const { checkLockout, resetLockouts } = await import("@/lib/auth/lockout");
    resetLockouts();
    const headers = new Headers({ origin: ORIGIN, "x-amexlens-request": "1", "content-type": "application/json" });
    for (let i = 0; i < 6; i++) {
      const res = await POST(new Request(`${ORIGIN}/api/auth/login/totp`, { method: "POST", headers, body: bigJson("code", MiB) }));
      expect(res.status).toBe(413);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    // Six oversized posts did not count as six wrong codes.
    expect(checkLockout("login")).toBeNull();
  });

  it("exchange, link-token, consent, repair and transaction PATCH refuse oversized bodies with 413", async () => {
    installPlaidFake();
    await loadApp();
    const post = (p: string, body: string, method = "POST") =>
      new Request(`http://localhost${p}`, { method, headers: { "content-type": "application/json" }, body });
    const params = { params: Promise.resolve({ id: "tx1" }) };

    const exchange = (await import("@/app/api/plaid/exchange/route")).POST;
    expect((await exchange(post("/api/plaid/exchange", bigJson("public_token", MiB)))).status).toBe(413);
    const link = (await import("@/app/api/plaid/link-token/route")).POST;
    expect((await link(post("/api/plaid/link-token", bigJson("mode", MiB)))).status).toBe(413);
    const consent = (await import("@/app/api/plaid/consent/route")).POST;
    expect((await consent(post("/api/plaid/consent", bigJson("item_id", MiB)))).status).toBe(413);
    const repair = (await import("@/app/api/plaid/repair/route")).POST;
    expect((await repair(post("/api/plaid/repair", bigJson("item_id", MiB)))).status).toBe(413);
    const patch = (await import("@/app/api/transactions/[id]/route")).PATCH;
    expect((await patch(post("/api/transactions/tx1", bigJson("bucket", MiB), "PATCH"), params)).status).toBe(413);
    // Small bodies still take the normal validation path.
    expect((await exchange(post("/api/plaid/exchange", "{bad"))).status).toBe(400);
    expect((await patch(post("/api/transactions/tx1", "null", "PATCH"), params)).status).toBe(400);
  });
});

describe("RT-04 unauthenticated passkey assertion options are rate limited", () => {
  it("30 per minute, then 429 with Retry-After (lockout still applies first)", async () => {
    await loadApp(REQUIRED_ENV);
    const { POST } = await import("@/app/api/auth/login/passkey/options/route");
    const OPTIONS_LIMIT = 30;
    for (let i = 0; i < OPTIONS_LIMIT; i++) {
      const res = await POST(makeReq("/api/auth/login/passkey/options", { method: "POST", body: {} }));
      expect(res.status, `call ${i + 1}`).toBe(200);
    }
    const limited = await POST(makeReq("/api/auth/login/passkey/options", { method: "POST", body: {} }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: { code: "rate_limited" } });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("RT-06 CSP upgrade-insecure-requests follows the origin scheme; HSTS is runtime", () => {
  it("buildCsp: upgrade defaults to !dev and can be switched off for a plain-http origin", async () => {
    const { buildCsp, isPlainHttpOrigin } = await import("@/lib/security-headers.mjs");
    expect(buildCsp({ dev: false })).toContain("upgrade-insecure-requests");
    expect(buildCsp({ dev: false, upgrade: false })).not.toContain("upgrade-insecure-requests");
    expect(buildCsp({ dev: true, upgrade: true })).toContain("upgrade-insecure-requests");
    expect(isPlainHttpOrigin("http://100.64.0.2:3000")).toBe(true);
    expect(isPlainHttpOrigin("https://cards.example")).toBe(false);
    expect(isPlainHttpOrigin(undefined)).toBe(false);
  });

  it("middleware: no upgrade on an http APP_ORIGIN in a production build; HSTS on every response when ENABLE_HSTS=1", async () => {
    try {
      vi.stubEnv("AUTH_MODE", "required");
      vi.stubEnv("COOKIE_INSECURE_DEV", "");
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("APP_ORIGIN", "http://100.64.0.2:3000");
      vi.stubEnv("ENABLE_HSTS", "1");
      vi.resetModules();
      const { middleware } = await import("@/middleware");
      const page = middleware(new NextRequest("http://100.64.0.2:3000/login"));
      expect(page.headers.get("content-security-policy")).not.toContain("upgrade-insecure-requests");
      expect(page.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
      const api401 = middleware(new NextRequest("http://100.64.0.2:3000/api/items"));
      expect(api401.status).toBe(401);
      expect(api401.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
      const redirect = middleware(new NextRequest("http://100.64.0.2:3000/transactions"));
      expect(redirect.status).toBe(307);
      expect(redirect.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");

      vi.stubEnv("APP_ORIGIN", "https://cards.example");
      vi.stubEnv("ENABLE_HSTS", "");
      vi.resetModules();
      const { middleware: mw2 } = await import("@/middleware");
      const https = mw2(new NextRequest("https://cards.example/login"));
      expect(https.headers.get("content-security-policy")).toContain("upgrade-insecure-requests");
      expect(https.headers.get("strict-transport-security")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("RT-07 PLAID_REDIRECT_URI must be on APP_ORIGIN", () => {
  it("boot refuses a redirect URI on another origin and accepts the same origin", async () => {
    await loadApp({ ...REQUIRED_ENV, PLAID_REDIRECT_URI: "http://localhost:3000/plaid/oauth" });
    const ok = (await import("@/lib/boot")).assertBootConfig;
    expect(ok).not.toThrow();
    await loadApp({ ...REQUIRED_ENV, PLAID_REDIRECT_URI: "http://attacker.example/plaid/oauth" });
    const bad = (await import("@/lib/boot")).assertBootConfig;
    expect(bad).toThrow(/PLAID_REDIRECT_URI must be on APP_ORIGIN/);
    await loadApp({ ...REQUIRED_ENV, PLAID_REDIRECT_URI: "http://localhost:3001/plaid/oauth" });
    const port = (await import("@/lib/boot")).assertBootConfig;
    expect(port).toThrow(/PLAID_REDIRECT_URI must be on APP_ORIGIN/);
  });
});

describe("RT-08 defaults and audit coverage", () => {
  it("PLAID_COUNTRY_CODES defaults to CA only", async () => {
    await loadApp();
    const { env } = await import("@/lib/env");
    expect(env.PLAID_COUNTRY_CODES).toEqual(["CA"]);
  });

  it("a successful exchange writes a link.exchange audit row with the item id only", async () => {
    installPlaidFake();
    const { dir } = await loadApp();
    const { POST } = await import("@/app/api/plaid/exchange/route");
    const res = await POST(
      new Request("http://localhost/api/plaid/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ public_token: "public-sandbox-1" }),
      })
    );
    expect(res.status).toBe(200);
    const raw = new Database(`${dir}/test.sqlite`, { readonly: true });
    try {
      const rows = raw
        .prepare("SELECT event, item_id, outcome, detail FROM security_log WHERE event = 'link.exchange'")
        .all() as Array<{ event: string; item_id: string; outcome: string; detail: string | null }>;
      expect(rows).toEqual([{ event: "link.exchange", item_id: "item_fake_001", outcome: "ok", detail: null }]);
      const all = JSON.stringify(raw.prepare("SELECT * FROM security_log").all());
      expect(all).not.toMatch(/access-sandbox|public-sandbox/);
    } finally {
      raw.close();
    }
  });

  it("rate-limit and lockout trips are logged as events, without caller data", async () => {
    await loadApp(REQUIRED_ENV);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });
    const { rateLimited } = await import("@/lib/http/rate-limit");
    rateLimited("probe", 1, 60_000);
    expect(rateLimited("probe", 1, 60_000)?.status).toBe(429);
    const { recordFailure, resetLockouts } = await import("@/lib/auth/lockout");
    resetLockouts();
    for (let i = 0; i < 5; i++) recordFailure("login");
    const trip = out.find((l) => l.includes('"event":"rate_limited"'));
    expect(trip).toBeTruthy();
    expect(JSON.parse(trip!)).toMatchObject({ level: "info", event: "rate_limited", scope: "probe" });
    const lock = err.find((l) => l.includes('"event":"login_locked_out"'));
    expect(lock).toBeTruthy();
    expect(JSON.parse(lock!)).toMatchObject({ level: "warn", event: "login_locked_out", scope: "login" });
  });
});
