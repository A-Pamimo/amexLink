import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { REQUIRED_ENV, json, makeReq } from "../helpers/auth";
import { captureConsole } from "../helpers/console";
import { installPlaidFake, plaidError } from "../helpers/plaid-fake";
import { req, seedItem } from "../helpers/seed";

let con: ReturnType<typeof captureConsole>;
beforeEach(() => {
  con = captureConsole();
});
afterEach(() => {
  con.restore();
  closeApp();
});

const ITEM = "plaid-item-1";
const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body) });

async function resetLimits() {
  const { resetRateLimits } = await import("@/lib/http/rate-limit");
  resetRateLimits();
}

describe("POST /api/plaid/consent", () => {
  it("requires a session and the custom header under AUTH_MODE=required", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp(REQUIRED_ENV);
    await seedItem(db);
    await db.setItemStatus(ITEM, "consent_required", "ADDITIONAL_CONSENT_REQUIRED");
    await resetLimits();
    const { createSession } = await import("@/lib/auth/session");
    const token = await createSession();
    const { POST } = await import("@/app/api/plaid/consent/route");
    const path = "/api/plaid/consent";

    const noSession = await POST(makeReq(path, { method: "POST", body: { item_id: ITEM } }));
    expect(noSession.status).toBe(401);

    const noHeader = await POST(makeReq(path, { method: "POST", token, csrfHeader: false, body: { item_id: ITEM } }));
    expect(noHeader.status).toBe(403);
    expect(await noHeader.json()).toEqual({ error: { code: "csrf" } });

    const badOrigin = await POST(makeReq(path, { method: "POST", token, origin: "https://evil.example", body: { item_id: ITEM } }));
    expect(badOrigin.status).toBe(403);

    expect(plaid.liabilitiesGet).not.toHaveBeenCalled();
    expect((await db.getItemByItemId(ITEM))?.status).toBe("consent_required");

    const ok = await POST(makeReq(path, { method: "POST", token, body: { item_id: ITEM } }));
    expect(ok.status).toBe(200);
    expect((await db.getItemByItemId(ITEM))?.status).toBe("active");
  });

  it("liabilities now succeeds: consent_required becomes active; cached balances only", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    await seedItem(db);
    await db.setItemStatus(ITEM, "consent_required", "ADDITIONAL_CONSENT_REQUIRED");
    await db.setItemRefreshMeta(ITEM, {
      liabilities_status: "consent_required",
      balance_source: "cached",
      last_refreshed_at: "2026-10-30T00:00:00.000Z",
    });
    await resetLimits();
    const { POST } = await import("@/app/api/plaid/consent/route");

    const res = await POST(post("/api/plaid/consent", { item_id: ITEM }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, liabilities_status: "ok", item_status: "active" });

    const item = await db.getItemByItemId(ITEM);
    expect(item?.status).toBe("active");
    expect(item?.last_error).toBeNull();
    expect(item?.liabilities_status).toBe("ok");
    expect(plaid.liabilitiesGet).toHaveBeenCalledTimes(1);
    expect(plaid.accountsBalanceGet).not.toHaveBeenCalled();
  });

  it("consent still missing: stays consent_required and says so", async () => {
    const plaid = installPlaidFake();
    plaid.liabilitiesGet.mockRejectedValue(
      plaidError("ADDITIONAL_CONSENT_REQUIRED", { status: 400, error_type: "INVALID_INPUT" })
    );
    const { db } = await loadApp();
    await seedItem(db);
    await resetLimits();
    const { POST } = await import("@/app/api/plaid/consent/route");

    const res = await POST(post("/api/plaid/consent", { item_id: ITEM }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, liabilities_status: "consent_required", item_status: "consent_required" });
  });

  it("validates input and existence", async () => {
    installPlaidFake();
    await loadApp();
    await resetLimits();
    const { POST } = await import("@/app/api/plaid/consent/route");
    expect((await POST(req("/api/plaid/consent", { method: "POST", body: "{nope" }))).status).toBe(400);
    expect((await POST(post("/api/plaid/consent", {}))).status).toBe(400);
    expect((await POST(post("/api/plaid/consent", { item_id: 7 }))).status).toBe(400);
    const missing = await POST(post("/api/plaid/consent", { item_id: "ghost" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "item_not_found" } });
  });

  it("is limited to 6 per hour per item: the 7th call is 429 with Retry-After", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    await seedItem(db);
    await seedItem(db, { id: "row-2", item_id: "plaid-item-2" });
    await resetLimits();
    const { POST } = await import("@/app/api/plaid/consent/route");

    for (let i = 0; i < 6; i++) {
      expect((await POST(post("/api/plaid/consent", { item_id: ITEM }))).status).toBe(200);
    }
    const seventh = await POST(post("/api/plaid/consent", { item_id: ITEM }));
    expect(seventh.status).toBe(429);
    expect(seventh.headers.get("Retry-After")).toBeTruthy();
    expect(plaid.liabilitiesGet).toHaveBeenCalledTimes(6);

    // another item has its own bucket
    expect((await POST(post("/api/plaid/consent", { item_id: "plaid-item-2" }))).status).toBe(200);
  });
});

describe("POST /api/plaid/repair", () => {
  it("requires a session and the custom header under AUTH_MODE=required", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp(REQUIRED_ENV);
    await seedItem(db);
    await db.setItemStatus(ITEM, "needs_relink", "ITEM_LOGIN_REQUIRED");
    await resetLimits();
    const { createSession } = await import("@/lib/auth/session");
    const token = await createSession();
    const { POST } = await import("@/app/api/plaid/repair/route");

    expect((await POST(makeReq("/api/plaid/repair", { method: "POST", body: { item_id: ITEM } }))).status).toBe(401);
    const noHeader = await POST(makeReq("/api/plaid/repair", { method: "POST", token, csrfHeader: false, body: { item_id: ITEM } }));
    expect(noHeader.status).toBe(403);
    expect(plaid.transactionsSync).not.toHaveBeenCalled();
    expect((await db.getItemByItemId(ITEM))?.status).toBe("needs_relink");
  });

  it("needs_relink becomes active and the item is synced", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    await seedItem(db);
    await db.setItemStatus(ITEM, "needs_relink", "ITEM_LOGIN_REQUIRED");
    await resetLimits();
    const { POST } = await import("@/app/api/plaid/repair/route");

    const res = await POST(post("/api/plaid/repair", { item_id: ITEM }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, sync: { ok: true } });
    expect(plaid.transactionsSync).toHaveBeenCalled();
    const item = await db.getItemByItemId(ITEM);
    expect(item?.status).toBe("active");
    expect(item?.last_error).toBeNull();
    expect(await db.countTransactions()).toBe(3);
  });

  it("a sync that still fails is reported in `sync` and the item is flagged again", async () => {
    const plaid = installPlaidFake();
    plaid.transactionsSync.mockRejectedValue(
      plaidError("ITEM_LOGIN_REQUIRED", { status: 400, requestBody: "access-sandbox-secret-123" })
    );
    const { db } = await loadApp();
    await seedItem(db);
    await db.setItemStatus(ITEM, "needs_relink", "ITEM_LOGIN_REQUIRED");
    await resetLimits();
    const { POST } = await import("@/app/api/plaid/repair/route");

    const res = await POST(post("/api/plaid/repair", { item_id: ITEM }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("access-sandbox");
    expect(JSON.parse(text)).toEqual({ ok: true, sync: { ok: false, error_code: "relink_required" } });
    expect((await db.getItemByItemId(ITEM))?.status).toBe("needs_relink");
  });

  it("validates input, 404s unknown items, and leaves a half-revoked item alone", async () => {
    installPlaidFake();
    const { db } = await loadApp();
    await seedItem(db);
    await db.setItemStatus(ITEM, "revoke_failed", "INTERNAL_SERVER_ERROR");
    await resetLimits();
    const { POST } = await import("@/app/api/plaid/repair/route");

    expect((await POST(post("/api/plaid/repair", {}))).status).toBe(400);
    expect((await POST(post("/api/plaid/repair", { item_id: "ghost" }))).status).toBe(404);
    const revoking = await POST(post("/api/plaid/repair", { item_id: ITEM }));
    expect(revoking.status).toBe(409);
    expect((await db.getItemByItemId(ITEM))?.status).toBe("revoke_failed");
  });
});
