import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { installPlaidFake } from "../helpers/plaid-fake";
import { req, seedItem } from "../helpers/seed";

const SECRET = "c".repeat(40);

beforeEach(async () => {
  const { resetRateLimits } = await import("@/lib/http/rate-limit");
  resetRateLimits();
});
afterEach(() => closeApp());

const post = (url: string, headers: Record<string, string> = {}) =>
  req(url, { method: "POST", headers });

describe("authorizeSync", () => {
  it("accepts the correct bearer", async () => {
    await loadApp({ CRON_SECRET: SECRET });
    const { authorizeSync } = await import("@/lib/sync/authorize");
    expect(await authorizeSync(post("/api/plaid/sync", { authorization: `Bearer ${SECRET}` }))).toEqual({
      ok: true,
      via: "cron",
    });
  });

  it("rejects a wrong bearer, a prefix, and a different-length value with 401", async () => {
    await loadApp({ CRON_SECRET: SECRET });
    const { authorizeSync } = await import("@/lib/sync/authorize");
    for (const bad of ["Bearer nope", `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(1)}`, `Basic ${SECRET}`, "Bearer"]) {
      const r = await authorizeSync(post("/api/plaid/sync", { authorization: bad }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(401);
        expect(await r.response.json()).toEqual({ error: { code: "unauthenticated" } });
      }
    }
  });

  it("rejects any bearer with 401 when no CRON_SECRET is configured", async () => {
    await loadApp();
    const { authorizeSync } = await import("@/lib/sync/authorize");
    const r = await authorizeSync(post("/api/plaid/sync", { authorization: `Bearer ${SECRET}` }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("ignores a secret in the query string (it does not authenticate as cron)", async () => {
    await loadApp({ CRON_SECRET: SECRET });
    const { authorizeSync } = await import("@/lib/sync/authorize");
    const r = await authorizeSync(post(`/api/plaid/sync?cron_secret=${SECRET}&token=${SECRET}`));
    expect(r).toEqual({ ok: true, via: "session-pending" });
  });

  it("refuses to boot with a short CRON_SECRET", async () => {
    await expect(loadApp({ CRON_SECRET: "short" })).rejects.toThrow(/CRON_SECRET/);
  });
});

describe("POST /api/plaid/sync auth", () => {
  it("401 for a wrong bearer and does not touch Plaid or the DB", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp({ CRON_SECRET: SECRET });
    await seedItem(db);
    const { POST } = await import("@/app/api/plaid/sync/route");
    const res = await POST(post("/api/plaid/sync", { authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
    expect(plaid.transactionsSync).not.toHaveBeenCalled();
  });

  it("200 for the correct bearer, with counts only", async () => {
    installPlaidFake();
    const { db } = await loadApp({ CRON_SECRET: SECRET });
    await seedItem(db);
    const { POST } = await import("@/app/api/plaid/sync/route");
    const res = await POST(post("/api/plaid/sync", { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      items: [{ item_id: "plaid-item-1", ok: true, added: 3, modified: 0, removed: 0 }],
      totals: { added: 3, modified: 0, removed: 0 },
    });
    expect(text).not.toContain("access-sandbox");
    expect(text).not.toContain("cursor");
  });

  it("a query-string secret is ignored by the route as well", async () => {
    installPlaidFake();
    const { db } = await loadApp({ CRON_SECRET: SECRET });
    await seedItem(db);
    const { POST } = await import("@/app/api/plaid/sync/route");
    // Authenticates as nothing (session-pending), so it is subject to the manual rate limit, not cron's.
    const res = await POST(post(`/api/plaid/sync?secret=${SECRET}`));
    expect(res.status).toBe(200);
    const { rateLimit } = await import("@/lib/http/rate-limit");
    for (let i = 0; i < 5; i++) expect(rateLimit("sync:all", 6, 3_600_000).ok).toBe(true);
    expect(rateLimit("sync:all", 6, 3_600_000).ok).toBe(false);
  });

  it("single-item sync: unknown item is 404; a relink failure is 409 with provider_code only", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp({ CRON_SECRET: SECRET });
    await seedItem(db);
    const { POST } = await import("@/app/api/plaid/sync/route");
    const auth = { authorization: `Bearer ${SECRET}` };
    expect((await POST(post("/api/plaid/sync?item_id=nope", auth))).status).toBe(404);

    const { plaidError } = await import("../helpers/plaid-fake");
    plaid.transactionsSync.mockRejectedValueOnce(plaidError("ITEM_LOGIN_REQUIRED"));
    const res = await POST(post("/api/plaid/sync?item_id=plaid-item-1", auth));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "relink_required", provider_code: "ITEM_LOGIN_REQUIRED" },
    });
  });
});

