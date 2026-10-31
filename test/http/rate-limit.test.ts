import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { installPlaidFake } from "../helpers/plaid-fake";
import { req } from "../helpers/seed";

beforeEach(async () => {
  const { resetRateLimits } = await import("@/lib/http/rate-limit");
  resetRateLimits();
});
afterEach(() => {
  vi.restoreAllMocks();
  closeApp();
});

describe("rateLimit", () => {
  it("allows `limit` hits per window, then reports Retry-After, then recovers", async () => {
    const { rateLimit } = await import("@/lib/http/rate-limit");
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    for (let i = 0; i < 3; i++) expect(rateLimit("s", 3, 60_000).ok).toBe(true);
    const blocked = rateLimit("s", 3, 60_000);
    expect(blocked).toEqual({ ok: false, retryAfterSec: 60 });
    now += 30_000;
    expect(rateLimit("s", 3, 60_000)).toEqual({ ok: false, retryAfterSec: 30 });
    now += 30_001;
    expect(rateLimit("s", 3, 60_000).ok).toBe(true);
  });

  it("keeps scopes independent", async () => {
    const { rateLimit } = await import("@/lib/http/rate-limit");
    expect(rateLimit("a", 1, 1000).ok).toBe(true);
    expect(rateLimit("a", 1, 1000).ok).toBe(false);
    expect(rateLimit("b", 1, 1000).ok).toBe(true);
  });
});

describe("POST /api/plaid/link-token", () => {
  it("returns 429 with Retry-After on the 11th call in the window", async () => {
    installPlaidFake();
    await loadApp();
    const { resetRateLimits } = await import("@/lib/http/rate-limit");
    resetRateLimits();
    const { POST } = await import("@/app/api/plaid/link-token/route");
    for (let i = 0; i < 10; i++) {
      const ok = await POST(req("/api/plaid/link-token", { method: "POST" }));
      expect(ok.status).toBe(200);
    }
    const res = await POST(req("/api/plaid/link-token", { method: "POST" }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: { code: "rate_limited" } });
  });
});

describe("POST /api/plaid/sync rate limit", () => {
  it("allows 6 manual syncs per item per hour, 7th is 429", async () => {
    installPlaidFake();
    const { db } = await loadApp();
    await db.insertItem({
      id: "r1",
      access_token: "access-sandbox-x",
      item_id: "it1",
      institution_name: null,
      institution_id: null,
    });
    const { resetRateLimits } = await import("@/lib/http/rate-limit");
    resetRateLimits();
    const { POST } = await import("@/app/api/plaid/sync/route");
    const call = () => POST(new Request("http://localhost/api/plaid/sync?item_id=it1", { method: "POST" }));
    for (let i = 0; i < 6; i++) expect((await call()).status).toBe(200);
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
  });
});
