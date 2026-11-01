import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { captureConsole } from "../helpers/console";
import { installPlaidFake, plaidError } from "../helpers/plaid-fake";
import { seedItem } from "../helpers/seed";

let con: ReturnType<typeof captureConsole>;
beforeEach(() => {
  con = captureConsole();
});
afterEach(() => {
  con.restore();
  vi.doUnmock("@/lib/cards/refresh");
  closeApp();
});

describe("syncItem + card refresh", () => {
  it("refreshes cards from cached balances only (never the billed call)", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    const { syncItem } = await import("@/lib/transactions");
    await syncItem(item);

    expect(plaid.accountsGet).toHaveBeenCalledTimes(1);
    expect(plaid.accountsBalanceGet).not.toHaveBeenCalled();
    const rows = await db.listCardRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.balance_source === "cached" && r.liabilities_status === "ok")).toBe(true);
  });

  it("still commits transactions and advances the cursor when liabilitiesGet throws", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    plaid.liabilitiesGet.mockRejectedValue(plaidError("INTERNAL_SERVER_ERROR", { status: 500 }));
    const { syncItem } = await import("@/lib/transactions");

    await expect(syncItem(item)).resolves.toMatchObject({ added: 3 });
    expect(await db.countTransactions()).toBe(3);
    expect((await db.getItemByItemId(item.item_id))?.cursor).toBeTruthy();
    expect((await db.getItemByItemId(item.item_id))?.cursor).toBe("cursor-after-first-sync");

    // cards were still stored: balances present, liability fields carry the failure
    const amex = (await db.listCardRows()).find((r) => r.mask === "1005")!;
    expect(amex.fields.current_balance?.status).toBe("present");
    expect(amex.fields.minimum_payment).toMatchObject({ status: "error", error_code: "INTERNAL_SERVER_ERROR" });
    expect(amex.liabilities_status).toBe("error");
  });

  it("consent_required on liabilities marks the item but the sync still succeeds", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    plaid.liabilitiesGet.mockRejectedValue(
      plaidError("ADDITIONAL_CONSENT_REQUIRED", { status: 400, error_type: "INVALID_INPUT" })
    );
    const { syncItem } = await import("@/lib/transactions");
    await expect(syncItem(item)).resolves.toMatchObject({ added: 3 });
    expect((await db.getItemByItemId(item.item_id))?.status).toBe("consent_required");
  });

  it("an unexpected throw from refreshItemCards itself cannot fail the sync (own try/catch)", async () => {
    installPlaidFake();
    vi.doMock("@/lib/cards/refresh", () => ({
      refreshItemCards: vi.fn(async () => {
        throw new Error("exploded with access-sandbox-leak-123");
      }),
    }));
    const { db } = await loadApp();
    const item = await seedItem(db);
    const { syncItem } = await import("@/lib/transactions");
    await expect(syncItem(item)).resolves.toMatchObject({ added: 3 });
    expect(await db.countTransactions()).toBe(3);
    expect((await db.getItemByItemId(item.item_id))?.cursor).toBe("cursor-after-first-sync");
    expect(con.text()).toContain("cards_refresh_failed");
    expect(con.text()).not.toContain("access-sandbox-leak-123");
  });

  it("a failed transactions sync does not touch card data", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    plaid.transactionsSync.mockRejectedValue(plaidError("INTERNAL_SERVER_ERROR", { status: 500 }));
    const { syncItem } = await import("@/lib/transactions");
    await expect(syncItem(item)).rejects.toMatchObject({ code: "provider_error" });
    expect(plaid.accountsGet).not.toHaveBeenCalled();
    expect(await db.listCardRows()).toHaveLength(0);
  });
});
