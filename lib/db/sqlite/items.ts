import type Database from "better-sqlite3";
import type { ItemsRepo, PlaidItemInsert } from "../../db";
import type { PlaidItem } from "../../types";

// Never `SELECT *` here: the access token must only leave SQL through getItemSecret.
const ITEM_COLUMNS =
  "id, item_id, institution_name, institution_id, created_at, last_synced_at, cursor";

interface ItemRow {
  id: string;
  item_id: string;
  institution_name: string | null;
  institution_id: string | null;
  created_at: string;
  last_synced_at: string | null;
  cursor: string | null;
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
  };
}

export function itemsRepo(db: Database.Database): ItemsRepo {
  const insertItemStmt = db.prepare(`
    INSERT INTO plaid_items (id, access_token, item_id, institution_name, institution_id, created_at, last_synced_at, cursor)
    VALUES (@id, @access_token, @item_id, @institution_name, @institution_id, @created_at, NULL, NULL)
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
    `SELECT access_token FROM plaid_items WHERE item_id = ?`
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
    /** The only reader of the access token. Callers must never log or return it. */
    async getItemSecret(item_id) {
      const r = getItemSecretStmt.get(item_id) as { access_token: string } | undefined;
      return r ? { access_token: r.access_token } : null;
    },
    async insertItem(item: PlaidItemInsert) {
      const created_at = new Date().toISOString();
      insertItemStmt.run({ ...item, created_at });
      return rowToItem({
        id: item.id,
        item_id: item.item_id,
        institution_name: item.institution_name,
        institution_id: item.institution_id,
        created_at,
        last_synced_at: null,
        cursor: null,
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
