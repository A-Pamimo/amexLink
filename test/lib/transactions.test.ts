import { afterEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { installPlaidFake } from "../helpers/plaid-fake";

afterEach(() => closeApp());

describe("syncItem", () => {
  it("inserts fixture transactions and persists the cursor", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await db.insertItem({
      id: "row-1",
      access_token: "access-sandbox-secret-123",
      item_id: "plaid-item-1",
      institution_name: "Amex Canada",
      institution_id: "ins_100533",
    });

    const { syncItem } = await import("@/lib/transactions");
    const result = await syncItem(item);

    expect(result).toEqual({ added: 3, modified: 0, removed: 0 });
    expect(plaid.transactionsSync).toHaveBeenCalledTimes(1);
    expect(plaid.transactionsSync.mock.calls[0][0]).toMatchObject({
      access_token: "access-sandbox-secret-123",
    });

    expect(await db.countTransactions()).toBe(3);
    const rows = await db.listTransactions({ include_non_spending: true });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["tx_sbux_001"].bucket).toBe("food");
    expect(byId["tx_uber_002"].bucket).toBe("transport");
    expect(byId["tx_pay_003"].bucket).toBe("transfers");
    expect(byId["tx_pay_003"].pending).toBe(1);

    const stored = await db.getItemByItemId("plaid-item-1");
    expect(stored!.cursor).toBe("cursor-after-first-sync");
    expect(stored!.last_synced_at).not.toBeNull();
  });

  it("is idempotent when the same page is replayed", async () => {
    installPlaidFake();
    const { db } = await loadApp();
    const item = await db.insertItem({
      id: "row-1",
      access_token: "access-sandbox-secret-123",
      item_id: "plaid-item-1",
      institution_name: null,
      institution_id: null,
    });
    const { syncItem } = await import("@/lib/transactions");
    await syncItem(item);
    const second = await syncItem(item);
    expect(second.added).toBe(0);
    expect(await db.countTransactions()).toBe(3);
  });
});
