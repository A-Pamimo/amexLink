import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["AUTH_MODE", "COOKIE_INSECURE_DEV"]) saved[k] = process.env[k];
  process.env.AUTH_MODE = "required";
  delete process.env.COOKIE_INSECURE_DEV;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const BASE = "http://localhost:3000";
const TOKEN = "A".repeat(43);

function req(path: string, cookie?: string) {
  return new NextRequest(`${BASE}${path}`, cookie ? { headers: { cookie } } : undefined);
}

function passedThrough(res: Response): boolean {
  return res.status === 200 && res.headers.get("x-middleware-next") === "1";
}

describe("middleware", () => {
  it("/api/items without a cookie → 401 JSON, no redirect", async () => {
    const res = middleware(req("/api/items"));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: "unauthenticated" } });
  });

  it("/transactions without a cookie → 307 to /login?from=/transactions", () => {
    const res = middleware(req("/transactions"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe(BASE);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("from")).toBe("/transactions");
  });

  it("drops the original query string from `from`", () => {
    const res = middleware(req("/settings?tab=x"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("from")).toBe("/settings");
    expect([...loc.searchParams.keys()]).toEqual(["from"]);
  });

  it("exempts /api/health, /login and /api/auth/*", () => {
    expect(passedThrough(middleware(req("/api/health")))).toBe(true);
    expect(passedThrough(middleware(req("/login")))).toBe(true);
    expect(passedThrough(middleware(req("/login?from=%2Fx")))).toBe(true);
    expect(passedThrough(middleware(req("/api/auth/status")))).toBe(true);
    expect(passedThrough(middleware(req("/api/auth/login/totp")))).toBe(true);
    // but not look-alikes
    expect(middleware(req("/api/healthz")).status).toBe(401);
    expect(middleware(req("/loginx")).status).toBe(307);
  });

  it("passes a token-shaped cookie through and rejects non-token values", () => {
    expect(passedThrough(middleware(req("/api/items", `__Host-amexlens_session=${TOKEN}`)))).toBe(true);
    expect(passedThrough(middleware(req("/transactions", `__Host-amexlens_session=${TOKEN}`)))).toBe(true);
    expect(middleware(req("/api/items", "__Host-amexlens_session=ok")).status).toBe(401);
    expect(middleware(req("/api/items", "amexlens_auth=ok")).status).toBe(401);
    expect(middleware(req("/api/items", `amexlens_session=${TOKEN}`)).status).toBe(401); // wrong name without the dev flag
  });

  it("uses the dev cookie name only with COOKIE_INSECURE_DEV=1", () => {
    process.env.COOKIE_INSECURE_DEV = "1";
    expect(passedThrough(middleware(req("/api/items", `amexlens_session=${TOKEN}`)))).toBe(true);
    expect(middleware(req("/api/items", `__Host-amexlens_session=${TOKEN}`)).status).toBe(401);
  });

  it("is a no-op under AUTH_MODE=none", () => {
    process.env.AUTH_MODE = "none";
    expect(passedThrough(middleware(req("/api/items")))).toBe(true);
    expect(passedThrough(middleware(req("/transactions")))).toBe(true);
  });
});
