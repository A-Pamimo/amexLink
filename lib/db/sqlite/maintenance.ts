import type Database from "better-sqlite3";
import type { MaintenanceRepo } from "../../db";

// Settings that are not card data and must survive "delete all local data":
//  - webauthn_user_id: the WebAuthn user handle (changing it would orphan enrolled passkeys);
//  - plaid_client_user_id: the per-install Plaid client_user_id (stable across re-links).
const KEEP_SETTINGS = ["webauthn_user_id", "plaid_client_user_id"];

export function maintenanceRepo(db: Database.Database): MaintenanceRepo {
  const del = {
    transactions: db.prepare(`DELETE FROM transactions`),
    fields: db.prepare(`DELETE FROM account_fields`),
    accounts: db.prepare(`DELETE FROM accounts`),
    items: db.prepare(`DELETE FROM plaid_items`),
    settings: db.prepare(
      `DELETE FROM settings WHERE key NOT IN (${KEEP_SETTINGS.map(() => "?").join(", ")})`
    ),
  };
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  const run = db.transaction(() => {
    const counts = {
      items: count("plaid_items"),
      accounts: count("accounts"),
      transactions: count("transactions"),
    };
    // Children first; the FKs cascade anyway, this keeps the order explicit.
    del.transactions.run();
    del.fields.run();
    del.accounts.run();
    del.items.run();
    del.settings.run(...KEEP_SETTINGS);
    return counts;
  });

  return {
    async deleteAllCardData() {
      return run();
    },
  };
}
