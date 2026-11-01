import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole } from "../helpers/console";
import { closeApp, loadApp } from "../helpers/app";
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

const post = (body: unknown) =>
  req("/api/plaid/exchange", { method: "POST", body: JSON.stringify(body) });

describe("POST /api/plaid/exchange", () => {
  it("takes institution from Plaid and ignores the client-supplied one", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const { POST } = await import("@/app/api/plaid/exchange/route");

    const res = await POST(
      post({ public_token: "public-sandbox-1", institution: { name: "Evil Bank", id: "ins_evil" } })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      item_id: "item_fake_001",
      institution_name: "American Express Canada",
      sync: { ok: true, added: 3, modified: 0, removed: 0 },
    });

    expect(plaid.institutionsGetById).toHaveBeenCalledWith({
      institution_id: "ins_100533",
      country_codes: ["US", "CA"],
    });
    const stored = await db.getItemByItemId("item_fake_001");
    expect(stored?.institution_name).toBe("American Express Canada");
    expect(stored?.institution_id).toBe("ins_100533");
    expect(JSON.stringify(stored)).not.toContain("Evil");
  });

  it("duplicate item_id: revokes the new token, returns 409 already_linked, keeps the original row", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    await seedItem(db, { id: "row-old", item_id: "item_fake_001", access_token: "access-sandbox-old" });
    const { POST } = await import("@/app/api/plaid/exchange/route");

    const res = await POST(post({ public_token: "public-sandbox-1" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "already_linked" } });
    expect(plaid.itemRemove).toHaveBeenCalledTimes(1);
    expect(plaid.itemRemove).toHaveBeenCalledWith({ access_token: "access-sandbox-fake" });
    expect((await db.listItems()).map((i) => i.id)).toEqual(["row-old"]);
    expect(plaid.transactionsSync).not.toHaveBeenCalled();
  });

  it("a failing first sync still links the item: 200 with sync.ok === false", async () => {
    const plaid = installPlaidFake();
    plaid.transactionsSync.mockRejectedValue(plaidError("INTERNAL_SERVER_ERROR", { status: 500 }));
    const { db } = await loadApp();
    const { POST } = await import("@/app/api/plaid/exchange/route");

    const res = await POST(post({ public_token: "public-sandbox-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.item_id).toBe("item_fake_001");
    expect(body.sync).toEqual({ ok: false, code: "provider_error" });
    expect(await db.getItemByItemId("item_fake_001")).not.toBeNull();
  });

  it("an institution lookup failure does not fail the link", async () => {
    const plaid = installPlaidFake();
    plaid.itemGet.mockRejectedValueOnce(plaidError("INTERNAL_SERVER_ERROR", { status: 500 }));
    const { db } = await loadApp();
    const { POST } = await import("@/app/api/plaid/exchange/route");
    const res = await POST(post({ public_token: "public-sandbox-1" }));
    expect(res.status).toBe(200);
    expect((await db.getItemByItemId("item_fake_001"))?.institution_name).toBeNull();
  });

  it("revokes the token and returns 500 when the insert fails for another reason", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    db.insertItem = async () => {
      throw new Error("SQLITE_FULL");
    };
    const { POST } = await import("@/app/api/plaid/exchange/route");
    const res = await POST(post({ public_token: "public-sandbox-1" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "storage_error" } });
    expect(plaid.itemRemove).toHaveBeenCalledWith({ access_token: "access-sandbox-fake" });
  });

  it("rejects missing or non-string public_token and bad JSON without calling Plaid", async () => {
    const plaid = installPlaidFake();
    await loadApp();
    const { POST } = await import("@/app/api/plaid/exchange/route");
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post({ public_token: { $ne: 1 } }))).status).toBe(400);
    expect((await POST(req("/api/plaid/exchange", { method: "POST", body: "{" }))).status).toBe(400);
    expect(plaid.itemPublicTokenExchange).not.toHaveBeenCalled();
  });

  it("rate limits exchange at 10 per hour", async () => {
    installPlaidFake();
    await loadApp();
    const { resetRateLimits } = await import("@/lib/http/rate-limit");
    resetRateLimits();
    const { POST } = await import("@/app/api/plaid/exchange/route");
    for (let i = 0; i < 10; i++) {
      expect((await POST(post({}))).status).toBe(400); // counted even though invalid
    }
    const res = await POST(post({}));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});
