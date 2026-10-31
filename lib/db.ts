import "server-only";
import { env } from "./env";
import type {
  AccountRow,
  BalanceSource,
  CardRow,
  FieldKey,
  FieldObservation,
  LiabilitiesStatus,
  ProviderCard,
} from "./providers/types";
import type {
  BucketKey,
  BucketTotals,
  ItemStatus,
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
  /** The only way to read an access token. Never log or return the result. */
  getItemSecret(item_id: string): Promise<{ access_token: string } | null>;
  /** Returns the stored item WITHOUT the access token. */
  insertItem(item: PlaidItemInsert): Promise<PlaidItem>;
  updateItemSync(item_id: string, cursor: string, last_synced_at: string): Promise<void>;
  deleteItem(id: string): Promise<void>;
}

/** WP4: item lifecycle (status, institution metadata, cursor compare-and-set). */
export interface ItemLifecycleRepo {
  /** `last_error` is a provider error_code enum string only, never a message. */
  setItemStatus(item_id: string, status: ItemStatus, last_error?: string | null): Promise<void>;
  updateItemInstitution(
    item_id: string,
    institution_id: string | null,
    institution_name: string | null
  ): Promise<void>;
  /**
   * `UPDATE ... WHERE item_id = ? AND cursor IS ?`. Returns true only if the stored
   * cursor still equalled `expectedCursor` (null = never synced) and was replaced.
   */
  casUpdateCursor(
    item_id: string,
    expectedCursor: string | null,
    newCursor: string,
    last_synced_at: string
  ): Promise<boolean>;
}

export interface TransactionPage {
  added: TransactionInsert[];
  modified: TransactionInsert[];
  removedIds: string[];
}

export interface TransactionsRepo {
  upsertAddedTransactions(rows: TransactionInsert[]): Promise<number>;
  upsertModifiedTransactions(rows: TransactionInsert[]): Promise<number>;
  removeTransactions(ids: string[]): Promise<number>;
  listTransactions(filters: TransactionFilters): Promise<Transaction[]>;
  patchTransactionBucket(id: string, bucket: BucketKey): Promise<Transaction | null>;
  resetTransactionBucket(id: string): Promise<Transaction | null>;
  countTransactions(): Promise<number>;
  /** WP4: applies one sync page (added, modified, removed) in a single DB transaction. */
  applyTransactionPage(page: TransactionPage): Promise<{ added: number; modified: number; removed: number }>;
}

export interface StatsRepo {
  bucketTotals(range: StatsRange): Promise<BucketTotals>;
  monthlyTrend(months: number, item_id?: string, include_non_spending?: boolean): Promise<MonthlyTrendPoint[]>;
}

export interface CoreRepo {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  appendSecurityLog(row: SecurityLogInsert): Promise<void>;
  /** WP4: `SELECT 1`; true when the database answers. */
  ping(): Promise<boolean>;
  /** WP4: reclaim freed pages (e.g. after deleting an item). Must run outside a transaction. */
  vacuum(): Promise<void>;
}

export interface ItemRefreshMeta {
  liabilities_status: LiabilitiesStatus;
  balance_source: BalanceSource;
  last_refreshed_at: string;
}

/** WP6a: provider accounts and per-field observations. Written only by the refresh path. */
export interface CardsRepo {
  /**
   * Insert or update accounts by `(provider, provider_account_id)`. Ids are random UUIDs and
   * stay stable across re-upserts. Returns `provider_account_id -> account id`.
   */
  upsertAccounts(
    item_id: string,
    provider: string,
    cards: ProviderCard[]
  ): Promise<Record<string, string>>;
  /** Delete + insert in one transaction, so a refresh never leaves a half-written card. */
  replaceAccountFields(
    account_id: string,
    provider: string,
    obs: Partial<Record<FieldKey, FieldObservation>>
  ): Promise<void>;
  /** Every stored account with its observations, joined with its item. */
  listCardRows(): Promise<CardRow[]>;
  setItemRefreshMeta(item_id: string, meta: ItemRefreshMeta): Promise<void>;
  getAccountById(id: string): Promise<AccountRow | null>;
}

// Add one XRepo interface above and one `extends` here per feature area.
export interface DB
  extends ItemsRepo,
    ItemLifecycleRepo,
    TransactionsRepo,
    StatsRepo,
    CoreRepo,
    CardsRepo {}

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
