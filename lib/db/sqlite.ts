import "server-only";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { categorizeTx } from "../categorize";
import type {
  DB,
  PlaidItemInsert,
  StatsRange,
  TransactionInsert,
} from "../db";
import {
  ALL_BUCKETS,
  NON_SPENDING_BUCKETS,
  type BucketKey,
  type BucketTotals,
  type MonthlyTrendPoint,
  type PlaidItem,
  type Transaction,
  type TransactionFilters,
} from "../types";

function ensureDir(p: string) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const dir = path.join(process.cwd(), "lib", "db", "migrations");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    db.prepare(`SELECT id FROM _migrations`).all().map((r: any) => r.id)
  );
  const insert = db.prepare(
    `INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`
  );
  for (const file of files) {
    const id = parseInt(file.split("_")[0], 10);
    if (Number.isNaN(id) || applied.has(id)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      insert.run(id, new Date().toISOString());
    })();
  }
}

function rowToItem(row: any): PlaidItem {
  return {
    id: row.id,
    access_token: row.access_token,
    item_id: row.item_id,
    institution_name: row.institution_name ?? null,
    institution_id: row.institution_id ?? null,
    created_at: row.created_at,
    last_synced_at: row.last_synced_at ?? null,
    cursor: row.cursor ?? null,
  };
}

function rowToTx(row: any): Transaction {
  return {
    id: row.id,
    account_id: row.account_id,
    item_id: row.item_id,
    name: row.name,
    amount: row.amount,
    iso_currency_code: row.iso_currency_code ?? null,
    date: row.date,
    plaid_category: row.plaid_category ?? null,
    plaid_category_detailed: row.plaid_category_detailed ?? null,
    merchant_name: row.merchant_name ?? null,
    logo_url: row.logo_url ?? null,
    bucket: row.bucket as BucketKey,
    bucket_override: row.bucket_override,
    pending: row.pending,
    created_at: row.created_at,
  };
}

export function createSqliteDB(dbPath: string): DB {
  ensureDir(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);

  const insertItemStmt = db.prepare(`
    INSERT INTO plaid_items (id, access_token, item_id, institution_name, institution_id, created_at, last_synced_at, cursor)
    VALUES (@id, @access_token, @item_id, @institution_name, @institution_id, @created_at, NULL, NULL)
  `);
  const updateItemSyncStmt = db.prepare(`
    UPDATE plaid_items SET cursor = ?, last_synced_at = ? WHERE item_id = ?
  `);
  const getItemByItemIdStmt = db.prepare(
    `SELECT * FROM plaid_items WHERE item_id = ?`
  );
  const listItemsStmt = db.prepare(
    `SELECT * FROM plaid_items ORDER BY created_at DESC`
  );
  const deleteItemStmt = db.prepare(`DELETE FROM plaid_items WHERE id = ?`);

  const insertTxStmt = db.prepare(`
    INSERT OR IGNORE INTO transactions
      (id, account_id, item_id, name, amount, iso_currency_code, date,
       plaid_category, plaid_category_detailed, merchant_name, logo_url,
       bucket, bucket_override, pending, created_at)
    VALUES
      (@id, @account_id, @item_id, @name, @amount, @iso_currency_code, @date,
       @plaid_category, @plaid_category_detailed, @merchant_name, @logo_url,
       @bucket, 0, @pending, @created_at)
  `);

  const updateTxKeepBucketStmt = db.prepare(`
    UPDATE transactions SET
      account_id = @account_id,
      name = @name,
      amount = @amount,
      iso_currency_code = @iso_currency_code,
      date = @date,
      plaid_category = @plaid_category,
      plaid_category_detailed = @plaid_category_detailed,
      merchant_name = @merchant_name,
      logo_url = @logo_url,
      pending = @pending
    WHERE id = @id
  `);

  const updateTxRecategorizeStmt = db.prepare(`
    UPDATE transactions SET
      account_id = @account_id,
      name = @name,
      amount = @amount,
      iso_currency_code = @iso_currency_code,
      date = @date,
      plaid_category = @plaid_category,
      plaid_category_detailed = @plaid_category_detailed,
      merchant_name = @merchant_name,
      logo_url = @logo_url,
      bucket = @bucket,
      pending = @pending
    WHERE id = @id AND bucket_override = 0
  `);

  const getOverrideStmt = db.prepare(
    `SELECT bucket_override FROM transactions WHERE id = ?`
  );
  const deleteTxStmt = db.prepare(`DELETE FROM transactions WHERE id = ?`);
  const getTxStmt = db.prepare(`SELECT * FROM transactions WHERE id = ?`);
  const patchBucketStmt = db.prepare(
    `UPDATE transactions SET bucket = ?, bucket_override = 1 WHERE id = ?`
  );

  function upsertAdded(rows: TransactionInsert[]): number {
    if (rows.length === 0) return 0;
    let count = 0;
    const tx = db.transaction((batch: TransactionInsert[]) => {
      for (const r of batch) {
        const params = {
          ...r,
          pending: r.pending ? 1 : 0,
          created_at: new Date().toISOString(),
        };
        const res = insertTxStmt.run(params);
        if (res.changes === 1) count++;
        else {
          // already exists (e.g. seen as pending earlier) — fall through to modified update
          const existing = getOverrideStmt.get(r.id) as any;
          if (existing) {
            if (existing.bucket_override === 1) {
              updateTxKeepBucketStmt.run(params);
            } else {
              updateTxRecategorizeStmt.run(params);
            }
          }
        }
      }
    });
    tx(rows);
    return count;
  }

  function upsertModified(rows: TransactionInsert[]): number {
    if (rows.length === 0) return 0;
    let count = 0;
    const tx = db.transaction((batch: TransactionInsert[]) => {
      for (const r of batch) {
        const existing = getOverrideStmt.get(r.id) as any;
        const params = {
          ...r,
          pending: r.pending ? 1 : 0,
        };
        if (!existing) {
          // Not in DB — treat as added (Plaid can include in modified if we missed the add).
          insertTxStmt.run({
            ...params,
            created_at: new Date().toISOString(),
          });
          count++;
          continue;
        }
        const res =
          existing.bucket_override === 1
            ? updateTxKeepBucketStmt.run(params)
            : updateTxRecategorizeStmt.run(params);
        if (res.changes === 1) count++;
      }
    });
    tx(rows);
    return count;
  }

  function remove(ids: string[]): number {
    if (ids.length === 0) return 0;
    let count = 0;
    const tx = db.transaction((batch: string[]) => {
      for (const id of batch) {
        const res = deleteTxStmt.run(id);
        if (res.changes === 1) count++;
      }
    });
    tx(ids);
    return count;
  }

  function buildList(filters: TransactionFilters): { sql: string; params: any[] } {
    const where: string[] = [];
    const params: any[] = [];
    if (filters.from) {
      where.push("date >= ?");
      params.push(filters.from);
    }
    if (filters.to) {
      where.push("date <= ?");
      params.push(filters.to);
    }
    if (filters.bucket) {
      where.push("bucket = ?");
      params.push(filters.bucket);
    }
    if (filters.item_id) {
      where.push("item_id = ?");
      params.push(filters.item_id);
    }
    if (filters.q) {
      where.push("(name LIKE ? OR merchant_name LIKE ?)");
      const like = `%${filters.q}%`;
      params.push(like, like);
    }
    if (!filters.include_non_spending) {
      const placeholders = NON_SPENDING_BUCKETS.map(() => "?").join(",");
      where.push(`bucket NOT IN (${placeholders})`);
      params.push(...NON_SPENDING_BUCKETS);
    }
    const sql =
      `SELECT * FROM transactions` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY date DESC, created_at DESC` +
      (filters.limit ? ` LIMIT ${Math.max(1, Math.min(1000, filters.limit | 0))}` : "") +
      (filters.offset ? ` OFFSET ${Math.max(0, filters.offset | 0)}` : "");
    return { sql, params };
  }

  return {
    async listItems() {
      return listItemsStmt.all().map(rowToItem);
    },
    async getItemByItemId(item_id) {
      const r = getItemByItemIdStmt.get(item_id);
      return r ? rowToItem(r) : null;
    },
    async insertItem(item: PlaidItemInsert) {
      const created_at = new Date().toISOString();
      insertItemStmt.run({ ...item, created_at });
      return {
        ...item,
        created_at,
        last_synced_at: null,
        cursor: null,
      };
    },
    async updateItemSync(item_id, cursor, last_synced_at) {
      updateItemSyncStmt.run(cursor, last_synced_at, item_id);
    },
    async deleteItem(id) {
      deleteItemStmt.run(id);
    },

    async upsertAddedTransactions(rows) {
      return upsertAdded(rows);
    },
    async upsertModifiedTransactions(rows) {
      return upsertModified(rows);
    },
    async removeTransactions(ids) {
      return remove(ids);
    },
    async listTransactions(filters) {
      const { sql, params } = buildList(filters);
      return db.prepare(sql).all(...params).map(rowToTx);
    },
    async patchTransactionBucket(id, bucket) {
      const res = patchBucketStmt.run(bucket, id);
      if (res.changes === 0) return null;
      const r = getTxStmt.get(id);
      return r ? rowToTx(r) : null;
    },
    async resetTransactionBucket(id) {
      const r = getTxStmt.get(id) as any;
      if (!r) return null;
      const auto = categorizeTx(r.plaid_category_detailed, r.merchant_name);
      db.prepare(
        `UPDATE transactions SET bucket = ?, bucket_override = 0 WHERE id = ?`
      ).run(auto, id);
      const updated = getTxStmt.get(id);
      return updated ? rowToTx(updated) : null;
    },
    async countTransactions() {
      const r = db.prepare(`SELECT COUNT(*) AS c FROM transactions`).get() as any;
      return r.c as number;
    },

    async bucketTotals({ from, to, item_id, include_non_spending }: StatsRange) {
      const where: string[] = ["pending = 0", "date BETWEEN ? AND ?"];
      const params: any[] = [from, to];
      if (item_id) {
        where.push("item_id = ?");
        params.push(item_id);
      }
      if (!include_non_spending) {
        const placeholders = NON_SPENDING_BUCKETS.map(() => "?").join(",");
        where.push(`bucket NOT IN (${placeholders})`);
        params.push(...NON_SPENDING_BUCKETS);
      }
      const rows = db
        .prepare(
          `SELECT bucket, SUM(amount) AS total FROM transactions WHERE ${where.join(
            " AND "
          )} GROUP BY bucket`
        )
        .all(...params) as Array<{ bucket: BucketKey; total: number }>;
      const out: BucketTotals = {};
      for (const r of rows) out[r.bucket] = r.total;
      return out;
    },

    async monthlyTrend(months, item_id, include_non_spending) {
      const where: string[] = ["pending = 0"];
      const params: any[] = [];
      if (item_id) {
        where.push("item_id = ?");
        params.push(item_id);
      }
      if (!include_non_spending) {
        const placeholders = NON_SPENDING_BUCKETS.map(() => "?").join(",");
        where.push(`bucket NOT IN (${placeholders})`);
        params.push(...NON_SPENDING_BUCKETS);
      }

      const monthsList: string[] = [];
      const now = new Date();
      for (let i = months - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        monthsList.push(key);
      }
      const earliest = monthsList[0] + "-01";
      where.push("date >= ?");
      params.push(earliest);

      const rows = db
        .prepare(
          `SELECT substr(date, 1, 7) AS month, bucket, SUM(amount) AS total
           FROM transactions
           WHERE ${where.join(" AND ")}
           GROUP BY month, bucket`
        )
        .all(...params) as Array<{ month: string; bucket: BucketKey; total: number }>;

      const byMonth = new Map<string, MonthlyTrendPoint>();
      for (const m of monthsList) {
        byMonth.set(m, { month: m, total: 0, byBucket: {} });
      }
      for (const r of rows) {
        const point = byMonth.get(r.month);
        if (!point) continue;
        point.byBucket[r.bucket] = r.total;
        point.total += r.total;
      }
      // Ensure every bucket key exists for stable chart rendering.
      for (const point of byMonth.values()) {
        for (const b of ALL_BUCKETS) {
          if (point.byBucket[b] === undefined) point.byBucket[b] = 0;
        }
      }
      return monthsList.map((m) => byMonth.get(m)!);
    },
  };
}
