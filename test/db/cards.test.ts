import Database from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeApp, loadApp } from "../helpers/app";
import { makeCard, ob, present } from "../helpers/cards";
import { seedItem } from "../helpers/seed";

afterEach(() => closeApp());

describe("migration 0006", () => {
  it("creates accounts, account_fields and the plaid_items refresh columns", async () => {
    const { dir } = await loadApp();
    const raw = new Database(path.join(dir, "test.sqlite"), { readonly: true });
    const ids = (raw.prepare("SELECT id FROM _migrations").all() as Array<{ id: number }>).map((r) => r.id);
    expect(ids).toContain(6);
    const cols = (t: string) =>
      (raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols("accounts")).toEqual([
      "id", "item_id", "provider", "provider_account_id", "name", "official_name", "mask",
      "type", "subtype", "iso_currency_code", "created_at", "updated_at",
    ]);
    expect(cols("account_fields")).toEqual([
      "account_id", "field", "provider", "status", "value_json", "observed_at", "error_code",
    ]);
    expect(cols("plaid_items")).toEqual(
      expect.arrayContaining(["liabilities_status", "balance_source", "last_refreshed_at"])
    );
    const idx = (raw.prepare("PRAGMA index_list(accounts)").all() as Array<{ name: string }>).map((i) => i.name);
    expect(idx).toContain("accounts_item");
    raw.close();
  });
});

describe("CardsRepo", () => {
  it("upsertAccounts keeps ids stable per (provider, provider_account_id) and updates metadata", async () => {
    const { db } = await loadApp();
    const item = await seedItem(db);
    const first = await db.upsertAccounts(item.item_id, "plaid", [makeCard("pa-1"), makeCard("pa-2", { mask: "2222" })]);
    expect(Object.keys(first).sort()).toEqual(["pa-1", "pa-2"]);
    expect(first["pa-1"]).toMatch(/^[0-9a-f-]{36}$/);

    const second = await db.upsertAccounts(item.item_id, "plaid", [makeCard("pa-1", { name: "Renamed" })]);
    expect(second["pa-1"]).toBe(first["pa-1"]);
    const acc = await db.getAccountById(first["pa-1"]);
    expect(acc).toMatchObject({ name: "Renamed", item_id: item.item_id, provider: "plaid" });
    expect((await db.listCardRows()).map((r) => r.provider_account_id).sort()).toEqual(["pa-1", "pa-2"]);

    // same provider account id under another provider is a different account
    const other = await db.upsertAccounts(item.item_id, "yodlee", [makeCard("pa-1")]);
    expect(other["pa-1"]).not.toBe(first["pa-1"]);
  });

  it("replaceAccountFields replaces the provider's observations and round-trips values", async () => {
    const { db } = await loadApp();
    const item = await seedItem(db);
    const ids = await db.upsertAccounts(item.item_id, "plaid", [makeCard("pa-1")]);
    const id = ids["pa-1"];
    await db.replaceAccountFields(id, "plaid", makeCard("pa-1").fields);
    let [row] = await db.listCardRows();
    expect(Object.keys(row.fields)).toHaveLength(11);
    expect(row.fields.is_overdue).toMatchObject({ status: "present", value: false });
    expect(row.fields.apr?.value).toEqual([
      { apr_percentage: 20, apr_type: "purchase_apr", balance_subject_to_apr: null, interest_charge_amount: null },
    ]);

    await db.replaceAccountFields(id, "plaid", {
      current_balance: present(1),
      apr: ob("error", null, { error_code: "INTERNAL_SERVER_ERROR" }),
    });
    [row] = await db.listCardRows();
    expect(Object.keys(row.fields).sort()).toEqual(["apr", "current_balance"]);
    expect(row.fields.apr).toMatchObject({ status: "error", value: null, error_code: "INTERNAL_SERVER_ERROR" });
  });

  it("listCardRows joins the item and setItemRefreshMeta updates it", async () => {
    const { db } = await loadApp();
    const item = await seedItem(db);
    await db.upsertAccounts(item.item_id, "plaid", [makeCard("pa-1")]);
    await db.setItemRefreshMeta(item.item_id, {
      liabilities_status: "consent_required",
      balance_source: "realtime",
      last_refreshed_at: "2026-10-31T00:00:00.000Z",
    });
    const [row] = await db.listCardRows();
    expect(row).toMatchObject({
      item_id: item.item_id,
      institution_name: "Amex Canada",
      item_status: "active",
      last_synced_at: null,
      liabilities_status: "consent_required",
      balance_source: "realtime",
      last_refreshed_at: "2026-10-31T00:00:00.000Z",
    });
    expect(JSON.stringify(row)).not.toContain("access-sandbox");
    expect(await db.getAccountById("missing")).toBeNull();
  });

  it("deleting the item cascades to accounts and their fields", async () => {
    const { db, dir } = await loadApp();
    const item = await seedItem(db);
    const ids = await db.upsertAccounts(item.item_id, "plaid", [makeCard("pa-1")]);
    await db.replaceAccountFields(ids["pa-1"], "plaid", makeCard("pa-1").fields);
    await db.deleteItem(item.id);
    const raw = new Database(path.join(dir, "test.sqlite"), { readonly: true });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM accounts").get()).toEqual({ n: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM account_fields").get()).toEqual({ n: 0 });
    raw.close();
  });
});
