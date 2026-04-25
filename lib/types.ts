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
  | "other";

export interface PlaidItem {
  id: number;
  access_token: string;
  item_id: string;
  institution_name: string | null;
  created_at: string;
  last_synced_at: string | null;
  cursor: string | null;
}

export interface Transaction {
  id: string;
  account_id: string;
  item_id: string;
  name: string;
  amount: number;
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

export interface BucketTotals {
  [key: string]: number;
}

export interface MonthlyTrendPoint {
  month: string; // YYYY-MM
  total: number;
  byBucket: BucketTotals;
}

