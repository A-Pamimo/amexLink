import type Database from "better-sqlite3";
import { decrypt, DecryptError, encrypt } from "../../crypto";
import type { ItemLifecycleRepo, ItemsRepo, PlaidItemInsert } from "../../db";
import { TokenUnreadableError } from "../../errors";
import { log } from "../../log";
import type { ItemStatus, PlaidItem } from "../../types";

// Never `SELECT *` here: the token ciphertext must only leave SQL through getItemSecret.
const ITEM_COLUMNS =
  "id, item_id, institution_name, institution_id, created_at, last_synced_at, cursor, status, last_error";

/** AAD binds the ciphertext to its row; moving it to another item fails to decrypt. */
function tokenAad(item_id: string): string {
  return `plaid_items:${item_id}`;
}

interface ItemRow {
  id: string;
  item_id: string;
  institution_name: string | null;
  institution_id: string | null;
  created_at: string;
  last_synced_at: string | null;
  cursor: string | null;
  status: string;
  last_error: string | null;
}

function rowToItem(row: ItemRow): PlaidItem {
  return {
    id: row.id,
    item_id: row.item_id,
    institution_name: row.institution_name ?? null,
    institution_id: row.institution_id ?? null,
    created_at: row.created_at,
    last_synced_at: row.last_synced_at ?? null,
    cursor: row.cursor ?? null,
    status: (row.status ?? "active") as ItemStatus,
    last_error: row.last_error ?? null,
  };
}

export function itemsRepo(db: Database.Database): ItemsRepo {
  const insertItemStmt = db.prepare(`
    INSERT INTO plaid_items (id, access_token_ct, item_id, institution_name, institution_id, created_at, last_synced_at, cursor)
    VALUES (@id, @access_token_ct, @item_id, @institution_name, @institution_id, @created_at, NULL, NULL)
  `);
  const updateItemSyncStmt = db.prepare(`
    UPDATE plaid_items SET cursor = ?, last_synced_at = ? WHERE item_id = ?
  `);
  const getItemByIdStmt = db.prepare(
    `SELECT ${ITEM_COLUMNS} FROM plaid_items WHERE id = ?`
  );
  const getItemByItemIdStmt = db.prepare(
    `SELECT ${ITEM_COLUMNS} FROM plaid_items WHERE item_id = ?`
  );
  const getItemSecretStmt = db.prepare(
    `SELECT access_token_ct FROM plaid_items WHERE item_id = ?`
  );
  const listItemsStmt = db.prepare(
    `SELECT ${ITEM_COLUMNS} FROM plaid_items ORDER BY created_at DESC`
  );
  const deleteItemStmt = db.prepare(`DELETE FROM plaid_items WHERE id = ?`);

  return {
    async listItems() {
      return (listItemsStmt.all() as ItemRow[]).map(rowToItem);
    },
    /** Lookup by our internal row id (`plaid_items.id`). */
    async getItemById(id) {
      const r = getItemByIdStmt.get(id) as ItemRow | undefined;
      return r ? rowToItem(r) : null;
    },
    /** Lookup by Plaid's item_id. */
    async getItemByItemId(item_id) {
      const r = getItemByItemIdStmt.get(item_id) as ItemRow | undefined;
      return r ? rowToItem(r) : null;
    },
    /**
     * The only reader of the access token. Decrypts in memory for the caller;
     * callers must never log or return it. A row whose ciphertext cannot be
     * opened throws TokenUnreadableError (the item needs a re-link); neither
     * the log line nor the error carries the ciphertext.
     */
    async getItemSecret(item_id) {
      const r = getItemSecretStmt.get(item_id) as
        | { access_token_ct: string | null }
        | undefined;
      if (!r) return null;
      if (r.access_token_ct === null) {
        log.error("token_decrypt_failed", { item_id, reason: "missing ciphertext" });
        throw new TokenUnreadableError(item_id);
      }
      try {
        return { access_token: decrypt(r.access_token_ct, tokenAad(item_id)) };
      } catch (err) {
        if (err instanceof DecryptError) {
          log.error("token_decrypt_failed", { item_id, reason: err.message });
          throw new TokenUnreadableError(item_id);
        }
        throw err;
      }
    },
    async insertItem(item: PlaidItemInsert) {
      const created_at = new Date().toISOString();
      insertItemStmt.run({
        id: item.id,
        access_token_ct: encrypt(item.access_token, tokenAad(item.item_id)),
        item_id: item.item_id,
        institution_name: item.institution_name,
        institution_id: item.institution_id,
        created_at,
      });
      return rowToItem({
        id: item.id,
        item_id: item.item_id,
        institution_name: item.institution_name,
        institution_id: item.institution_id,
        created_at,
        last_synced_at: null,
        cursor: null,
        status: "active",
        last_error: null,
      });
    },
    async updateItemSync(item_id, cursor, last_synced_at) {
      updateItemSyncStmt.run(cursor, last_synced_at, item_id);
    },
    async deleteItem(id) {
      deleteItemStmt.run(id);
    },
  };
}

// ---------------------------------------------------------------------------
// WP4 additions (append-only; kept apart from itemsRepo to avoid merge conflicts).
// ---------------------------------------------------------------------------

export function itemLifecycleRepo(db: Database.Database): ItemLifecycleRepo {
  const setStatusStmt = db.prepare(
    `UPDATE plaid_items SET status = ?, last_error = ? WHERE item_id = ?`
  );
  const setInstitutionStmt = db.prepare(
    `UPDATE plaid_items SET institution_id = ?, institution_name = ? WHERE item_id = ?`
  );
  // `cursor IS ?` is NULL-safe: a first sync (cursor NULL) matches expected null. Rows written by
  // older versions may hold "" (meaning "no cursor"); expected null matches those too.
  const casCursorStmt = db.prepare(
    `UPDATE plaid_items SET cursor = ?, last_synced_at = ?
     WHERE item_id = ? AND (cursor IS ? OR (? IS NULL AND cursor = ''))`
  );

  return {
    async setItemStatus(item_id, status, last_error = null) {
      setStatusStmt.run(status, last_error, item_id);
    },
    async updateItemInstitution(item_id, institution_id, institution_name) {
      setInstitutionStmt.run(institution_id, institution_name, item_id);
    },
    async casUpdateCursor(item_id, expectedCursor, newCursor, last_synced_at) {
      const res = casCursorStmt.run(
        newCursor,
        last_synced_at,
        item_id,
        expectedCursor,
        expectedCursor
      );
      return res.changes === 1;
    },
  };
}
