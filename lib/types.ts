import type { LiabilitiesStatus } from "./providers/types";

export type BucketKey =
  | "food"
  | "groceries"
  | "travel"
  | "transport"
  | "utilities"
  | "subscriptions"
  | "shopping"
  | "health"
  | "entertainment"
  | "education"
  | "income"
  | "transfers"
  | "other";

export const ALL_BUCKETS: BucketKey[] = [
  "food",
  "groceries",
  "travel",
  "transport",
  "utilities",
  "subscriptions",
  "shopping",
  "health",
  "entertainment",
  "education",
  "income",
  "transfers",
  "other",
];

export const NON_SPENDING_BUCKETS: BucketKey[] = ["income", "transfers"];

export const SPENDING_BUCKETS: BucketKey[] = ALL_BUCKETS.filter(
  (b) => !NON_SPENDING_BUCKETS.includes(b)
);

export const BUCKET_LABELS: Record<BucketKey, string> = {
  food: "Food & Drink",
  groceries: "Groceries",
  travel: "Travel",
  transport: "Transport",
  utilities: "Utilities",
  subscriptions: "Subscriptions",
  shopping: "Shopping",
  health: "Health",
  entertainment: "Entertainment",
  education: "Education",
  income: "Income",
  transfers: "Transfers & Payments",
  other: "Other",
};

export const BUCKET_COLORS: Record<BucketKey, string> = {
  food: "#f97316",
  groceries: "#22c55e",
  travel: "#38bdf8",
  transport: "#a78bfa",
  utilities: "#facc15",
  subscriptions: "#ec4899",
  shopping: "#f43f5e",
  health: "#14b8a6",
  entertainment: "#fb7185",
  education: "#60a5fa",
  income: "#4ade80",
  transfers: "#94a3b8",
  other: "#64748b",
};

export type ItemStatus = "active" | "needs_relink" | "consent_required" | "revoke_failed";

export interface PlaidItem {
  id: string;
  item_id: string;
  institution_name: string | null;
  institution_id: string | null;
  created_at: string;
  last_synced_at: string | null;
  cursor: string | null;
  status: ItemStatus;
  last_error: string | null;
  /** Last Liabilities outcome of a card refresh (null until the first refresh). */
  liabilities_status: LiabilitiesStatus | null;
}

export interface Transaction {
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
  bucket_override: number;
  pending: number;
  created_at: string;
}

export type BucketTotals = Partial<Record<BucketKey, number>>;

export interface MonthlyTrendPoint {
  month: string;
  total: number;
  byBucket: BucketTotals;
}

/** Spending per ISO currency code (`UNKNOWN` when absent). Amounts of different currencies are never added. */
export interface BucketTotalsByCurrency {
  byCurrency: Record<string, BucketTotals>;
  /** Currencies present in the result, CAD first, `UNKNOWN` last. */
  currencies: string[];
}

export interface MonthlyTrendByCurrency {
  /** One series per currency; every series has the same months, oldest first. */
  byCurrency: Record<string, MonthlyTrendPoint[]>;
  currencies: string[];
}

export interface SyncResult {
  added: number;
  modified: number;
  removed: number;
}

/** One entry of a sync response. Counts and a short code only; never provider text. */
export interface ItemSyncSummary extends SyncResult {
  item_id: string;
  ok: boolean;
  error_code?: string;
}

export interface SyncAllResult {
  items: ItemSyncSummary[];
  totals: SyncResult;
}

export interface TransactionFilters {
  from?: string;
  to?: string;
  bucket?: BucketKey;
  item_id?: string;
  q?: string;
  limit?: number;
  offset?: number;
  include_non_spending?: boolean;
}
