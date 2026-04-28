CREATE TABLE IF NOT EXISTS plaid_items (
  id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  item_id TEXT NOT NULL UNIQUE,
  institution_name TEXT,
  institution_id TEXT,
  created_at TEXT NOT NULL,
  last_synced_at TEXT,
  cursor TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES plaid_items(item_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  iso_currency_code TEXT,
  date TEXT NOT NULL,
  plaid_category TEXT,
  plaid_category_detailed TEXT,
  merchant_name TEXT,
  logo_url TEXT,
  bucket TEXT NOT NULL,
  bucket_override INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS tx_bucket ON transactions(bucket);
CREATE INDEX IF NOT EXISTS tx_item ON transactions(item_id);
