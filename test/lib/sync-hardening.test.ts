import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole } from "../helpers/console";
import { closeApp, loadApp } from "../helpers/app";
import { installPlaidFake, plaidError } from "../helpers/plaid-fake";
import transactionsSyncFixture from "../fixtures/plaid/transactions_sync.json";
import { seedItem } from "../helpers/seed";

let con: ReturnType<typeof captureConsole>;
beforeEach(() => {
  con = captureConsole();
});
afterEach(() => {
  con.restore();
  closeApp();
});

const page = (over: Record<string, unknown>) => ({
  data: { ...structuredClone(transactionsSyncFixture), ...over },
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("syncItem locking", () => {
  it("serialises concurrent syncs of one item", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    const { _locksForTest } = await import("@/lib/sync/lock");
    const { syncItem } = await import("@/lib/transactions");

    const gate = deferred<void>();
    let inflight = 0;
    let maxInflight = 0;
    plaid.transactionsSync.mockImplementation(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await gate.promise;
      inflight--;
      return page({});
    });

    const first = syncItem(item);
    const second = syncItem(item);
    await new Promise((r) => setTimeout(r, 25));
    expect(plaid.transactionsSync).toHaveBeenCalledTimes(1); // second is queued behind the lock
    expect(_locksForTest().size).toBe(1);

    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(maxInflight).toBe(1);
    expect(plaid.transactionsSync).toHaveBeenCalledTimes(2);
    expect(a.added).toBe(3);
    expect(b.added).toBe(0); // replay is idempotent
    expect(_locksForTest().size).toBe(0);

    // the queued call started from the cursor the first one saved
    expect(plaid.transactionsSync.mock.calls[1][0]).toMatchObject({ cursor: "cursor-after-first-sync" });
  });

  it("releases the lock when a sync throws", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    const { _locksForTest } = await import("@/lib/sync/lock");
    const { syncItem } = await import("@/lib/transactions");
    plaid.transactionsSync.mockRejectedValueOnce(plaidError("INTERNAL_SERVER_ERROR", { status: 500 }));
    await expect(syncItem(item)).rejects.toMatchObject({ name: "SyncError", code: "provider_error" });
    expect(_locksForTest().size).toBe(0);
    await expect(syncItem(item)).resolves.toMatchObject({ added: 3 });
  });
});

describe("cursor compare-and-set", () => {
  it("does not overwrite a cursor that changed between read and write", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    const { syncItem } = await import("@/lib/transactions");

    plaid.transactionsSync.mockImplementationOnce(async () => {
      // another writer advances the cursor while this sync is mid-flight
      await db.updateItemSync(item.item_id, "cursor-from-someone-else", "2026-10-31T00:00:00.000Z");
      return page({ next_cursor: "cursor-stale-result" });
    });

    const result = await syncItem(item);
    expect(result.added).toBe(3); // page was still applied (idempotent)
    expect((await db.getItemByItemId(item.item_id))?.cursor).toBe("cursor-from-someone-else");
    expect(con.text()).toContain("sync_cursor_conflict");
  });

  it("casUpdateCursor matches NULL and exact values only", async () => {
    const { db } = await loadApp();
    await seedItem(db);
    expect(await db.casUpdateCursor("plaid-item-1", "wrong", "c1", "t")).toBe(false);
    expect(await db.casUpdateCursor("plaid-item-1", null, "c1", "t")).toBe(true);
    expect(await db.casUpdateCursor("plaid-item-1", null, "c2", "t")).toBe(false);
    expect(await db.casUpdateCursor("plaid-item-1", "c1", "c2", "t")).toBe(true);
    expect((await db.getItemByItemId("plaid-item-1"))?.cursor).toBe("c2");
    // legacy "" counts as "no cursor"
    await db.updateItemSync("plaid-item-1", "", "t");
    expect(await db.casUpdateCursor("plaid-item-1", "x", "c3", "t")).toBe(false);
    expect(await db.casUpdateCursor("plaid-item-1", null, "c3", "t")).toBe(true);
  });

  it("never stores an empty-string cursor", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    const { syncItem } = await import("@/lib/transactions");
    plaid.transactionsSync.mockResolvedValueOnce(page({ next_cursor: "" }));
    await syncItem(item);
    expect((await db.getItemByItemId(item.item_id))?.cursor).toBeNull();

    // a legacy "" cursor already in the DB is treated as no cursor
    await db.updateItemSync(item.item_id, "", "2026-10-31T00:00:00.000Z");
    await syncItem(item);
    expect(plaid.transactionsSync.mock.calls[1][0].cursor).toBeUndefined();
    expect((await db.getItemByItemId(item.item_id))?.cursor).toBe("cursor-after-first-sync");
  });
});

describe("pagination mutation restart", () => {
  const p1 = () =>
    page({
      added: [transactionsSyncFixture.added[0]],
      next_cursor: "c-page1",
      has_more: true,
    });
  const p2 = () =>
    page({
      added: transactionsSyncFixture.added.slice(1),
      next_cursor: "c-final",
      has_more: false,
    });

  it("restarts from the original cursor once and succeeds", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    const { syncItem } = await import("@/lib/transactions");

    plaid.transactionsSync
      .mockResolvedValueOnce(p1())
      .mockRejectedValueOnce(plaidError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"))
      .mockResolvedValueOnce(p1())
      .mockResolvedValueOnce(p2());

    const r = await syncItem(item);
    expect(r.added).toBe(3);
    expect(await db.countTransactions()).toBe(3);
    const cursors = plaid.transactionsSync.mock.calls.map((c) => c[0].cursor);
    expect(cursors).toEqual([undefined, "c-page1", undefined, "c-page1"]);
    expect((await db.getItemByItemId(item.item_id))?.cursor).toBe("c-final");
  });

  it("gives up after 3 attempts with a typed error and leaves the cursor alone", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    const { syncItem } = await import("@/lib/transactions");
    plaid.transactionsSync.mockRejectedValue(
      plaidError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION")
    );
    await expect(syncItem(item)).rejects.toMatchObject({ name: "SyncError", code: "provider_error" });
    expect(plaid.transactionsSync).toHaveBeenCalledTimes(3);
    expect((await db.getItemByItemId(item.item_id))?.cursor).toBeNull();
  });
});

describe("item status", () => {
  it("ITEM_LOGIN_REQUIRED sets needs_relink and throws SyncError(relink_required)", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    const { syncItem } = await import("@/lib/transactions");
    plaid.transactionsSync.mockRejectedValueOnce(plaidError("ITEM_LOGIN_REQUIRED"));
    await expect(syncItem(item)).rejects.toMatchObject({
      name: "SyncError",
      code: "relink_required",
      provider_code: "ITEM_LOGIN_REQUIRED",
    });
    const stored = await db.getItemByItemId(item.item_id);
    expect(stored?.status).toBe("needs_relink");
    expect(stored?.last_error).toBe("ITEM_LOGIN_REQUIRED");

    // a later successful sync heals the status
    await syncItem(item);
    const healed = await db.getItemByItemId(item.item_id);
    expect(healed?.status).toBe("active");
    expect(healed?.last_error).toBeNull();
  });

  it("a successful sync does not clear revoke_failed", async () => {
    installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    await db.setItemStatus(item.item_id, "revoke_failed", "INTERNAL_SERVER_ERROR");
    const { syncItem } = await import("@/lib/transactions");
    await syncItem(item);
    expect((await db.getItemByItemId(item.item_id))?.status).toBe("revoke_failed");
  });

  it("unreadable credential marks needs_relink without calling Plaid", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    db.getItemSecret = async () => {
      throw Object.assign(new Error("x"), { name: "DecryptError" });
    };
    const { syncItem } = await import("@/lib/transactions");
    await expect(syncItem(item)).rejects.toMatchObject({ code: "credential_unavailable" });
    expect(plaid.transactionsSync).not.toHaveBeenCalled();
    expect((await db.getItemByItemId(item.item_id))?.status).toBe("needs_relink");
  });
});

describe("syncAllItems", () => {
  it("continues past a failing item and reports its error_code", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const bad = await seedItem(db, { id: "r-bad", item_id: "item-bad", access_token: "access-sandbox-bad" });
    const good = await seedItem(db, { id: "r-good", item_id: "item-good", access_token: "access-sandbox-good" });
    plaid.transactionsSync.mockImplementation(async (reqBody) => {
      if (reqBody.access_token === "access-sandbox-bad") throw plaidError("ITEM_LOGIN_REQUIRED");
      return page({});
    });
    const { syncAllItems } = await import("@/lib/transactions");
    const res = await syncAllItems();

    const byId = Object.fromEntries(res.items.map((i) => [i.item_id, i]));
    expect(byId[bad.item_id]).toEqual({
      item_id: "item-bad",
      ok: false,
      added: 0,
      modified: 0,
      removed: 0,
      error_code: "relink_required",
    });
    expect(byId[good.item_id]).toEqual({
      item_id: "item-good",
      ok: true,
      added: 3,
      modified: 0,
      removed: 0,
    });
    expect(res.totals).toEqual({ added: 3, modified: 0, removed: 0 });
    expect(await db.countTransactions()).toBe(3);
    expect((await db.getItemByItemId("item-bad"))?.status).toBe("needs_relink");
    expect((await db.getItemByItemId("item-good"))?.cursor).toBe("cursor-after-first-sync");
  });
});
