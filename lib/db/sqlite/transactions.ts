import type Database from "better-sqlite3";
import { categorizeTx } from "../../categorize";
import type { TransactionInsert, TransactionsRepo } from "../../db";
import {
  NON_SPENDING_BUCKETS,
  type BucketKey,
  type Transaction,
  type TransactionFilters,
} from "../../types";

type SqlParam = string | number;

interface TxRow {
  id: string;
  account_id: string;
  item_id: string;
  name: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  plaid_category: string | null;
  plaid_category_detailed: string | null;
  merchant_name: string | null;
  logo_url: string | null;
  bucket: string;
  bucket_override: number;
  pending: number;
  created_at: string;
}

function rowToTx(row: TxRow): Transaction {
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

export function transactionsRepo(db: Database.Database): TransactionsRepo {
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
  const resetBucketStmt = db.prepare(
    `UPDATE transactions SET bucket = ?, bucket_override = 0 WHERE id = ?`
  );
  const countTxStmt = db.prepare(`SELECT COUNT(*) AS c FROM transactions`);

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
          const existing = getOverrideStmt.get(r.id) as
            | { bucket_override: number }
            | undefined;
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
        const existing = getOverrideStmt.get(r.id) as
          | { bucket_override: number }
          | undefined;
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

  function buildList(filters: TransactionFilters): { sql: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
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
      return (db.prepare(sql).all(...params) as TxRow[]).map(rowToTx);
    },
    async patchTransactionBucket(id, bucket) {
      const res = patchBucketStmt.run(bucket, id);
      if (res.changes === 0) return null;
      const r = getTxStmt.get(id) as TxRow | undefined;
      return r ? rowToTx(r) : null;
    },
    async resetTransactionBucket(id) {
      const r = getTxStmt.get(id) as TxRow | undefined;
      if (!r) return null;
      const auto = categorizeTx(r.plaid_category_detailed, r.merchant_name);
      resetBucketStmt.run(auto, id);
      const updated = getTxStmt.get(id) as TxRow | undefined;
      return updated ? rowToTx(updated) : null;
    },
    async countTransactions() {
      const r = countTxStmt.get() as { c: number };
      return r.c;
    },
  };
}
