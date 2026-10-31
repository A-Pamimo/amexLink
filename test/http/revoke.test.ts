import Database from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { plaidError, installPlaidFake } from "../helpers/plaid-fake";
import { SEED_TOKEN, req, seedItem } from "../helpers/seed";

afterEach(() => closeApp());

function auditRows(dir: string) {
  const raw = new Database(path.join(dir, "test.sqlite"), { readonly: true });
  try {
    return raw
      .prepare("SELECT event, item_id, outcome, detail FROM security_log ORDER BY id")
      .all() as Array<{ event: string; item_id: string; outcome: string; detail: string | null }>;
  } finally {
    raw.close();
  }
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("DELETE /api/items/[id] (revoke-then-delete)", () => {
  it("keeps the item and its token when Plaid fails, marks revoke_failed, returns 502 with provider_code only", async () => {
    const plaid = installPlaidFake();
    plaid.itemRemove.mockRejectedValueOnce(
      plaidError("INTERNAL_SERVER_ERROR", {
        status: 500,
        error_type: "API_ERROR",
        error_message: `boom for ${SEED_TOKEN}`,
        requestBody: JSON.stringify({ access_token: SEED_TOKEN }),
      })
    );
    const { db, dir } = await loadApp();
    await seedItem(db, { withTx: true });

    const { DELETE } = await import("@/app/api/items/[id]/route");
    const res = await DELETE(req("/api/items/row-1", { method: "DELETE" }), ctx("row-1"));
    expect(res.status).toBe(502);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toEqual({ error: { code: "revoke_failed", provider_code: "INTERNAL_SERVER_ERROR" } });
    expect(text).not.toContain("error_message");
    expect(text).not.toContain(SEED_TOKEN);

    // row, secret and transactions survive; item is flagged for retry
    expect(await db.getItemSecret("plaid-item-1")).toEqual({ access_token: SEED_TOKEN });
    expect(await db.countTransactions()).toBe(1);
    const item = await db.getItemById("row-1");
    expect(item?.status).toBe("revoke_failed");
    expect(item?.last_error).toBe("INTERNAL_SERVER_ERROR");
    expect(auditRows(dir)).toEqual([
      { event: "revoke", item_id: "plaid-item-1", outcome: "revoke_failed", detail: "INTERNAL_SERVER_ERROR" },
    ]);

    // a retry that succeeds completes the delete
    const retry = await DELETE(req("/api/items/row-1", { method: "DELETE" }), ctx("row-1"));
    expect(retry.status).toBe(200);
    expect(await db.getItemById("row-1")).toBeNull();
  });

  it("deletes the item and its transactions after Plaid accepts, and writes an audit row", async () => {
    const plaid = installPlaidFake();
    const { db, dir } = await loadApp();
    await seedItem(db, { withTx: true });

    const { DELETE } = await import("@/app/api/items/[id]/route");
    const res = await DELETE(req("/api/items/row-1", { method: "DELETE" }), ctx("row-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(plaid.itemRemove).toHaveBeenCalledWith({ access_token: SEED_TOKEN });
    expect(await db.getItemById("row-1")).toBeNull();
    expect(await db.countTransactions()).toBe(0);
    expect(auditRows(dir)).toEqual([
      { event: "revoke", item_id: "plaid-item-1", outcome: "ok", detail: null },
    ]);
  });

  it.each(["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"])(
    "treats %s as already removed and deletes locally",
    async (code) => {
      const plaid = installPlaidFake();
      plaid.itemRemove.mockRejectedValueOnce(plaidError(code));
      const { db, dir } = await loadApp();
      await seedItem(db, { withTx: true });

      const { DELETE } = await import("@/app/api/items/[id]/route");
      const res = await DELETE(req("/api/items/row-1", { method: "DELETE" }), ctx("row-1"));
      expect(res.status).toBe(200);
      expect(await db.getItemById("row-1")).toBeNull();
      expect(await db.countTransactions()).toBe(0);
      expect(auditRows(dir)[0]).toMatchObject({ event: "revoke", outcome: "already_removed" });
    }
  );

  it("keeps the row when the stored credential cannot be decrypted", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    await seedItem(db);
    const unreadable = Object.assign(new Error("bad ciphertext"), { name: "TokenUnreadableError" });
    db.getItemSecret = async () => {
      throw unreadable;
    };

    const { revokeItem } = await import("@/lib/items/revoke");
    const r = await revokeItem("row-1");
    expect(r).toEqual({ ok: false, code: "revoke_failed", provider_code: "CREDENTIAL_UNREADABLE" });
    expect(plaid.itemRemove).not.toHaveBeenCalled();
    expect((await db.getItemById("row-1"))?.status).toBe("revoke_failed");
  });

  it("404s for an unknown id", async () => {
    installPlaidFake();
    await loadApp();
    const { DELETE } = await import("@/app/api/items/[id]/route");
    const res = await DELETE(req("/api/items/nope", { method: "DELETE" }), ctx("nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "item_not_found" } });
  });
});
