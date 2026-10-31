import Database from "better-sqlite3";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  closeApp();
});

/** Every row of every table, as one JSON string (what a copied DB file would expose). */
function dumpAllTables(dir: string): { text: string; tables: Record<string, unknown[]> } {
  const raw = new Database(path.join(dir, "test.sqlite"), { readonly: true });
  try {
    const names = (
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    const tables: Record<string, unknown[]> = {};
    for (const n of names) tables[n] = raw.prepare(`SELECT * FROM "${n}"`).all();
    return { text: JSON.stringify(tables), tables };
  } finally {
    raw.close();
  }
}

const FORBIDDEN = ["123456789", "011401533", "371449635398431", "Pat Example", "pat@example.test"];

describe("refreshItemCards allowlist (SECURITY.md 3.5, P-T2, P-I2)", () => {
  it("persists none of the forbidden fields the Plaid fixtures carry, in any table", async () => {
    const plaid = installPlaidFake();
    const { db, dir } = await loadApp();
    const item = await seedItem(db);
    const { refreshItemCards } = await import("@/lib/cards/refresh");

    // Exercise both balance paths so both fixtures are ingested.
    await refreshItemCards(item.item_id, { realtimeBalance: false });
    await refreshItemCards(item.item_id, { realtimeBalance: true });
    expect(plaid.accountsGet).toHaveBeenCalledTimes(1);
    expect(plaid.accountsBalanceGet).toHaveBeenCalledTimes(1);
    expect(plaid.liabilitiesGet).toHaveBeenCalledTimes(2);

    const { text, tables } = dumpAllTables(dir);
    for (const bad of FORBIDDEN) expect(text).not.toContain(bad);
    for (const key of ["numbers", "owners", "account_number", "cash_advance", "persistent_account_id"]) {
      expect(text).not.toContain(key);
    }

    // The depository account is filtered out entirely.
    expect(text).not.toContain("acc_chequing");
    expect(text).not.toContain("Everyday Chequing");
    expect(text).not.toContain("9999");
    expect(tables.accounts).toHaveLength(2);

    // ...and the allowlisted data did land.
    const accounts = tables.accounts as Array<{ mask: string; iso_currency_code: string; provider: string }>;
    expect(accounts.map((a) => a.mask).sort()).toEqual(["1005", "4321"]);
    expect(accounts.every((a) => a.provider === "plaid")).toBe(true);
    expect(text).toContain("penalty_apr");

    // Fields table columns are exactly the allowlist of columns.
    const fields = tables.account_fields as Array<Record<string, unknown>>;
    expect(fields.length).toBe(22);
    expect(Object.keys(fields[0]).sort()).toEqual(
      ["account_id", "error_code", "field", "observed_at", "provider", "status", "value_json"].sort()
    );
  });

  it("writes an audit row with outcome and codes only", async () => {
    installPlaidFake();
    const { db, dir } = await loadApp();
    const item = await seedItem(db);
    const { refreshItemCards } = await import("@/lib/cards/refresh");
    await refreshItemCards(item.item_id, { realtimeBalance: false });

    const log = dumpAllTables(dir).tables.security_log as Array<{ event: string; outcome: string; detail: string }>;
    const row = log.find((r) => r.event === "cards_refresh");
    expect(row).toMatchObject({ outcome: "ok", detail: "balance=cached;realtime=0" });
    expect(JSON.stringify(log)).not.toMatch(/1500|1420|1005/);
  });

  it("logs no provider data when liabilities fail", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    plaid.liabilitiesGet.mockRejectedValueOnce(
      plaidError("INTERNAL_SERVER_ERROR", { status: 500, error_message: "acct 371449635398431 Pat Example" })
    );
    const { refreshItemCards } = await import("@/lib/cards/refresh");
    await refreshItemCards(item.item_id);
    for (const bad of FORBIDDEN) expect(con.text()).not.toContain(bad);
  });
});

describe("refreshItemCards failure handling", () => {
  it("both account calls failing leaves existing rows untouched but records the attempt", async () => {
    const plaid = installPlaidFake();
    const { db, dir } = await loadApp();
    const item = await seedItem(db);
    const { refreshItemCards } = await import("@/lib/cards/refresh");
    await refreshItemCards(item.item_id);
    const before = dumpAllTables(dir).tables;

    plaid.accountsBalanceGet.mockRejectedValueOnce(plaidError("INTERNAL_SERVER_ERROR", { status: 500 }));
    plaid.accountsGet.mockRejectedValueOnce(plaidError("INTERNAL_SERVER_ERROR", { status: 500 }));
    const out = await refreshItemCards(item.item_id, { realtimeBalance: true });
    expect(out).toMatchObject({ ok: true, accounts_fetched: false, balance_source: "error", error_code: "INTERNAL_SERVER_ERROR", account_ids: [] });

    const after = dumpAllTables(dir).tables;
    expect(after.accounts).toEqual(before.accounts);
    expect(after.account_fields).toEqual(before.account_fields);

    const rows = await db.listCardRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].fields.current_balance?.status).toBe("present");
    expect(rows[0].balance_source).toBe("error");
    expect(rows[0].liabilities_status).toBe("error");
  });

  it("is idempotent: account ids stay stable and rows are replaced, not duplicated", async () => {
    installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    const { refreshItemCards } = await import("@/lib/cards/refresh");
    const a = await refreshItemCards(item.item_id);
    const b = await refreshItemCards(item.item_id);
    expect(b.account_ids.sort()).toEqual(a.account_ids.sort());
    expect(await db.listCardRows()).toHaveLength(2);
  });

  it("ADDITIONAL_CONSENT_REQUIRED marks the item consent_required, except revoke_failed", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    const other = await seedItem(db, { id: "row-2", item_id: "plaid-item-2" });
    const consent = () =>
      plaidError("ADDITIONAL_CONSENT_REQUIRED", { status: 400, error_type: "INVALID_INPUT" });
    plaid.liabilitiesGet.mockRejectedValue(consent());
    const { refreshItemCards } = await import("@/lib/cards/refresh");

    await refreshItemCards(item.item_id);
    expect(await db.getItemByItemId(item.item_id)).toMatchObject({
      status: "consent_required",
      last_error: "ADDITIONAL_CONSENT_REQUIRED",
    });
    expect((await db.listCardRows())[0].liabilities_status).toBe("consent_required");

    await db.setItemStatus(other.item_id, "revoke_failed", "UNKNOWN");
    await refreshItemCards(other.item_id);
    expect((await db.getItemByItemId(other.item_id))?.status).toBe("revoke_failed");

    // Consent granted later: the next successful refresh clears the status.
    plaid.liabilitiesGet.mockReset();
    plaid.liabilitiesGet.mockImplementation(async () => {
      const { default: fixture } = await import("../fixtures/plaid/liabilities_get.json");
      return { data: structuredClone(fixture) };
    });
    await refreshItemCards(item.item_id);
    expect(await db.getItemByItemId(item.item_id)).toMatchObject({ status: "active", last_error: null });
  });

  it("ITEM_LOGIN_REQUIRED from the accounts call marks needs_relink", async () => {
    const plaid = installPlaidFake();
    const { db } = await loadApp();
    const item = await seedItem(db);
    plaid.accountsGet.mockRejectedValueOnce(plaidError("ITEM_LOGIN_REQUIRED", { status: 400 }));
    const { refreshItemCards } = await import("@/lib/cards/refresh");
    await refreshItemCards(item.item_id);
    expect((await db.getItemByItemId(item.item_id))?.status).toBe("needs_relink");
  });

  it("unknown item is reported, not thrown", async () => {
    installPlaidFake();
    await loadApp();
    const { refreshItemCards } = await import("@/lib/cards/refresh");
    expect(await refreshItemCards("nope")).toMatchObject({ ok: false, code: "item_not_found" });
  });
});
