import "server-only";
import { env } from "./env";
import type {
  BucketKey,
  BucketTotals,
  MonthlyTrendPoint,
  PlaidItem,
  Transaction,
  TransactionFilters,
} from "./types";

export interface PlaidItemInsert {
  id: string;
  access_token: string;
  item_id: string;
  institution_name: string | null;
  institution_id: string | null;
}

export interface TransactionInsert {
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
  bucket: BucketKey;
  pending: boolean;
}

export interface StatsRange {
  from: string;
  to: string;
  item_id?: string;
  include_non_spending?: boolean;
}

export interface SecurityLogInsert {
  at?: string;
  event: string;
  item_id?: string | null;
  outcome?: string | null;
  detail?: string | null;
}

export interface ItemsRepo {
  listItems(): Promise<PlaidItem[]>;
  /** Lookup by our internal row id (`plaid_items.id`). */
  getItemById(id: string): Promise<PlaidItem | null>;
  /** Lookup by Plaid's item_id. */
  getItemByItemId(item_id: string): Promise<PlaidItem | null>;
  /**
   * The only way to read an access token (decrypted from `access_token_ct`).
   * Never log or return the result. Throws `TokenUnreadableError` (lib/errors)
   * when the ciphertext cannot be opened; the item then needs a re-link.
   */
  getItemSecret(item_id: string): Promise<{ access_token: string } | null>;
  /** Returns the stored item WITHOUT the access token. */
  insertItem(item: PlaidItemInsert): Promise<PlaidItem>;
  updateItemSync(item_id: string, cursor: string, last_synced_at: string): Promise<void>;
  deleteItem(id: string): Promise<void>;
}

export interface TransactionsRepo {
  upsertAddedTransactions(rows: TransactionInsert[]): Promise<number>;
  upsertModifiedTransactions(rows: TransactionInsert[]): Promise<number>;
  removeTransactions(ids: string[]): Promise<number>;
  listTransactions(filters: TransactionFilters): Promise<Transaction[]>;
  patchTransactionBucket(id: string, bucket: BucketKey): Promise<Transaction | null>;
  resetTransactionBucket(id: string): Promise<Transaction | null>;
  countTransactions(): Promise<number>;
}

export interface StatsRepo {
  bucketTotals(range: StatsRange): Promise<BucketTotals>;
  monthlyTrend(months: number, item_id?: string, include_non_spending?: boolean): Promise<MonthlyTrendPoint[]>;
}

export interface CoreRepo {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  appendSecurityLog(row: SecurityLogInsert): Promise<void>;
}

// Add one XRepo interface above and one `extends` here per feature area.
export interface DB extends ItemsRepo, TransactionsRepo, StatsRepo, CoreRepo {}

let cached: DB | null = null;

export async function getDB(): Promise<DB> {
  if (cached) return cached;
  if (env.STORAGE === "sqlite") {
    const mod = await import("./db/sqlite");
    cached = mod.createSqliteDB(env.DB_PATH);
    return cached;
  }
  throw new Error(
    `STORAGE=${env.STORAGE} is not implemented yet. Add a driver in lib/db/${env.STORAGE}.ts implementing the DB interface and dispatch it from getDB().`
  );
}
